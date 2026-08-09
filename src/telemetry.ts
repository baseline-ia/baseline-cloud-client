/**
 * Cloud addon: telemetry (event tracking + batching + flush).
 *
 * Fire-and-forget event ingest to a self-hosted baseline-cloud instance.
 * No PII is collected; payloads are scoped to command context (os,
 * versions, tool detection).
 *
 * Opt-out:
 *  - `BASELINE_TELEMETRY=0` or `BASELINE_TELEMETRY=false` env var
 *  - `baseline --no-telemetry` flag (handled by the core CLI; this
 *    module's setEnabled() also short-circuits)
 *
 * Events are batched in memory (max 20) and flushed:
 *   - When the batch fills up (20 events)
 *   - On a 5s interval (best-effort)
 *   - On process exit (SIGINT, SIGTERM, normal exit) — best-effort,
 *     fire-and-forget
 *
 * Network failures are silently swallowed. Telemetry NEVER blocks the
 * CLI. If the server returns 401 or 403, telemetry is disabled for the
 * rest of the process (so the user doesn't see a flood of auth errors
 * on every command).
 */
import { execSync } from 'node:child_process'
import { arch, version as nodeVersion } from 'node:process'
import { platform } from 'node:os'
import { logger } from './logger'
import { loadConfig, type CloudConfig } from './auth'

// ---------- Event type taxonomy ----------
// Centralized list so the addon's `track` calls and the cloud server's
// schema stay in sync. The core CLI's telemetry has its own EVENT_TYPES
// list for the cli.* events; this list is the superset (the addon's
// telemetry module is what delivers ALL events to the cloud, including
// the ones the host CLI emits via its `withTelemetry` wrapper).

export const EVENT_TYPES = [
  'cli.install',
  'cli.update',
  'cli.doctor',
  'cli.status',
  'cli.mcp',
  'cli.onboard',
  'cli.login',
  'cli.logout',
  'openspec.open',
  'openspec.update',
  'change.open',
  'change.close',
  'change.commit',
  'skill.installed',
  'skill.used',
  'engram.setup',
  'engram.update',
  'session.tokens',
  'session.credits',
  'sdd.phase.started',
  'sdd.phase.completed',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export const WORK_TYPES = [
  'feature',
  'migration',
  'new-project',
  'chore',
  'fix',
  'refactor',
  'docs',
] as const

export type WorkType = (typeof WORK_TYPES)[number]

/** Estimate buckets for the ROI computation. Matches the cloud server. */
const ESTIMATE_BUCKETS: Record<string, number> = {
  small: 30,
  medium: 120,
  large: 480,
  xlarge: 1920,
}

/**
 * Parse a user-supplied estimate string into a minute count.
 *
 * Accepts:
 *  - Bucket name: 'small' | 'medium' | 'large' | 'xlarge'
 *  - Hours: '4h', '4.5h', '0.5h'
 *  - Minutes: '30m', '240m'
 *  - Bare number: '240' (treated as minutes)
 *
 * Returns `{ minutes, bucket? }`. `bucket` is set only when the input
 * was a bucket name (so the caller can tell "user said small" from
 * "user said 30" — both are 30 minutes but the former carries
 * intentional bucket semantics).
 */
export function parseEstimate(raw: string): { minutes: number; bucket?: string } {
  const s = raw.trim().toLowerCase()

  if (Object.prototype.hasOwnProperty.call(ESTIMATE_BUCKETS, s)) {
    return { minutes: ESTIMATE_BUCKETS[s] as number, bucket: s }
  }

  const hoursMatch = s.match(/^(\d+(?:\.\d+)?)h$/)
  if (hoursMatch && hoursMatch[1]) {
    return { minutes: Math.round(parseFloat(hoursMatch[1]) * 60) }
  }

  const minutesMatch = s.match(/^(\d+(?:\.\d+)?)m$/)
  if (minutesMatch && minutesMatch[1]) {
    return { minutes: Math.round(parseFloat(minutesMatch[1])) }
  }

  const plainNumber = Number(s)
  if (!isNaN(plainNumber) && plainNumber > 0) {
    return { minutes: Math.round(plainNumber) }
  }

  throw new Error(
    `Invalid estimate '${raw}'. Use a bucket (small, medium, large, xlarge) or a duration (30m, 4h, 240).`
  )
}

export interface EventPayload {
  event_type: EventType
  project: string
  payload: Record<string, unknown>
  occurred_at?: string
}

/** Deliver a supplied batch and report whether the server confirmed it. */
export async function deliverEvents(events: EventPayload[]): Promise<boolean> {
  if (events.length === 0 || !isEnabled()) return false
  const cfg: CloudConfig | null = loadConfig()
  if (!cfg) return false

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${cfg.server_url}/api/v1/events/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.token}`,
        'User-Agent': `baseline-cli/${getCliVersion()}`,
      },
      body: JSON.stringify({ events }),
      signal: controller.signal,
    })
    if (!res.ok && (res.status === 401 || res.status === 403)) setEnabled(false)
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ---------- Batching + flush ----------

const BATCH_MAX = 20
const FLUSH_INTERVAL_MS = 5_000
const REQUEST_TIMEOUT_MS = 5_000

let _enabled = true
let _queue: EventPayload[] = []
let _flushTimer: NodeJS.Timeout | null = null
let _flushing = false
let _cliVersion: string | null = null

/**
 * Is telemetry currently enabled?
 *
 * Disabled when:
 *  - setEnabled(false) was called (--no-telemetry flag)
 *  - BASELINE_TELEMETRY=0 or =false env var
 *  - No cloud config is available (no env vars, no ~/.baseline/cloud.json)
 */
export function isEnabled(): boolean {
  if (!_enabled) return false
  if (process.env.BASELINE_TELEMETRY === '0' || process.env.BASELINE_TELEMETRY === 'false') {
    return false
  }
  return loadConfig() !== null
}

/**
 * Enable or disable telemetry. When disabling, clears the queue and
 * the flush timer so we don't send partial data after the user opted
 * out.
 */
export function setEnabled(enabled: boolean): void {
  _enabled = enabled
  if (!enabled) {
    _queue = []
    if (_flushTimer) {
      clearInterval(_flushTimer)
      _flushTimer = null
    }
  }
}

/**
 * Queue an event. Returns immediately. The event is sent to the
 * server either when the batch fills up (20 events) or when the
 * flush interval (5s) ticks, whichever comes first.
 *
 * If telemetry is disabled, this is a no-op.
 */
export function track(event: EventPayload): boolean {
  if (!isEnabled()) return false
  _queue.push({ ...event, occurred_at: event.occurred_at ?? new Date().toISOString() })
  if (_queue.length >= BATCH_MAX) {
    void flush()
  } else if (!_flushTimer) {
    _flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS)
    // Don't keep the process alive just for telemetry.
    _flushTimer.unref?.()
  }
  return true
}

/**
 * Flush the queue to the server NOW (bypassing the interval).
 *
 * - If a flush is already in progress, returns immediately (the other
 *   flush will pick up the new events).
 * - If the queue is empty, returns immediately.
 * - If the server returns 401/403, telemetry is auto-disabled for the
 *   rest of the process (the user has bad credentials and we don't
 *   want to flood the server with auth errors).
 * - All other failures (network, 5xx) are silently dropped. Telemetry
 *   never blocks the CLI.
 */
export async function flush(): Promise<void> {
  if (_flushing || _queue.length === 0) return
  _flushing = true
  try {
    const cfg: CloudConfig | null = loadConfig()
    if (!cfg) {
      _queue = []
      return
    }
    const events = _queue
    _queue = []

      await deliverEvents(events)
  } finally {
    _flushing = false
  }
}

/** @internal Reset the queue, timer, and config. Used by tests. */
export function _resetForTests(): void {
  _enabled = true
  _queue = []
  if (_flushTimer) {
    clearInterval(_flushTimer)
    _flushTimer = null
  }
  _flushing = false
  _cliVersion = null
}

export function setCliVersion(version: string): void {
  _cliVersion = version
}

function getCliVersion(): string {
  return _cliVersion ?? '0.0.0'
}

// ---------- Environment context (no PII) ----------

/**
 * Return a non-PII environment context. Sent with `cli.install` and
 * `skill.installed` events so the dashboard can show breakdowns by
 * OS / arch / Node version without collecting anything identifying.
 */
export function envContext(): { os: string; arch: string; nodeVersion: string } {
  return { os: platform(), arch, nodeVersion }
}

/**
 * Detect which AI dev tools the user has installed. Used in the
 * `cli.install` event payload so the dashboard can show tool
 * distribution.
 *
 * This shells out to `command -v <tool>` for each known tool. It is
 * best-effort: a missing `command` (Windows) or permission issue
 * results in `false` for that tool.
 */
export function detectTools(): Record<string, boolean> {
  const tools = ['claude', 'opencode', 'kiro', 'codex', 'antigravity']
  const result: Record<string, boolean> = {}
  for (const tool of tools) {
    try {
      execSync(`command -v ${tool}`, { stdio: 'ignore' })
      result[tool] = true
    } catch {
      result[tool] = false
    }
  }
  return result
}

// ---------- Process-exit flush ----------

let _exitRegistered = false

/**
 * Register a best-effort flush on process exit. Idempotent: calling
 * twice is a no-op.
 *
 * The exit flush is SYNCHRONOUS-ish: it fires a `fetch` but does NOT
 * await it. By the time `process.exit()` is called, the request may
 * or may not have completed. This is acceptable because the user is
 * leaving the process anyway; we send what we can.
 */
export function registerExitFlush(): void {
  if (_exitRegistered) return
  _exitRegistered = true
  const handler = () => {
    const cfg = loadConfig()
    if (!cfg || _queue.length === 0) return
    try {
      fetch(`${cfg.server_url}/api/v1/events/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.token}`,
        },
        body: JSON.stringify({ events: _queue }),
      }).catch(() => {})
    } catch {
      // ignore
    }
  }
  process.once('exit', handler)
  process.once('SIGINT', () => {
    handler()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    handler()
    process.exit(143)
  })
}

/** @internal Unregister the exit handler. Used by tests. */
export function _unregisterExitFlushForTests(): void {
  _exitRegistered = false
}

// Re-export logger for convenience (some addons want to log with the
// same formatting as the core).
export { logger }
