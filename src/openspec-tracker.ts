/**
 * Cloud addon: OpenSpec change tracker.
 *
 * Scans the user's project for OpenSpec change directories and fires
 * `change.open` / `change.close` events when changes appear or
 * disappear. Idempotent: state is persisted in
 * `~/.baseline/openspec-state.json` so we never fire duplicates.
 *
 * A change is detected at `<projectRoot>/openspec/changes/<name>/`.
 * The "closed" state is inferred by absence — if a change was in
 * state but is no longer in the directory tree, it was either
 * archived (moved to `archive/`) or deleted.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { track, isEnabled } from './telemetry'
import type { WorkType } from './telemetry'
import { getBaselineConfigDir } from './auth'

/**
 * Returns the state file path. Computed on each call (not cached) so
 * test overrides (via _setHomedirForTests) take effect immediately.
 */
function statePath(): string {
  return join(getBaselineConfigDir(), 'openspec-state.json')
}

interface State {
  lastSeenChanges: Record<
    string,
    {
      openedAt: number
      workType: WorkType
      title?: string
      estimateMin?: number
      estimateBucket?: string
    }
  >
}

function loadState(): State {
  if (!existsSync(statePath())) return { lastSeenChanges: {} }
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8')) as State
  } catch {
    return { lastSeenChanges: {} }
  }
}

function saveState(state: State): void {
  mkdirSync(dirname(statePath()), { recursive: true })
  writeFileSync(statePath(), JSON.stringify(state, null, 2), { mode: 0o600 })
}

/**
 * Read the YAML frontmatter of a proposal.md. Returns the work type
 * (defaults to 'feature' if missing or unreadable), the title (from
 * frontmatter or first heading), and the estimate if present.
 *
 * The parser is intentionally lenient: a corrupted or partial
 * frontmatter returns whatever fields it can extract, never throws.
 */
export function readProposalFrontmatter(proposalPath: string): {
  workType: WorkType
  title?: string
  estimateMin?: number
  estimateBucket?: string
} {
  if (!existsSync(proposalPath)) return { workType: 'feature' }
  try {
    const content = readFileSync(proposalPath, 'utf8')
    const match = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(content)
    if (!match || !match[1]) {
      const heading = /^#\s+(?:Proposal:\s*)?(.+)/m.exec(content)
      return { workType: 'feature', title: heading?.[1]?.trim() }
    }
    const fm = match[1]
    const typeMatch = /^type:\s*(\S+)/m.exec(fm)
    const titleMatch = /^title:\s*['"]?([^'"\n]+)['"]?/m.exec(fm)
    const estimateMatch = /^estimate_min:\s*(\d+)/m.exec(fm)
    const bucketMatch = /^estimate_bucket:\s*(\S+)/m.exec(fm)
    const workType = (typeMatch?.[1] as WorkType) ?? 'feature'
    return {
      workType,
      title: titleMatch?.[1]?.trim(),
      estimateMin:
        estimateMatch && estimateMatch[1] ? Number(estimateMatch[1]) : undefined,
      estimateBucket: bucketMatch?.[1],
    }
  } catch {
    return { workType: 'feature' }
  }
}

function findChangeDirs(projectRoot: string): string[] {
  const changesDir = join(projectRoot, 'openspec', 'changes')
  if (!existsSync(changesDir)) return []
  try {
    return readdirSync(changesDir)
      .filter((name) => {
        try {
          return statSync(join(changesDir, name)).isDirectory()
        } catch {
          return false
        }
      })
      .map((name) => join(changesDir, name))
  } catch {
    return []
  }
}

/**
 * Scan the project root for OpenSpec changes and emit events for any
 * new or closed changes. Safe to call on every CLI run.
 *
 * - New changes: present in the filesystem but not in the state file.
 *   Fires `change.open` with the work type and estimate from the
 *   proposal.md frontmatter.
 * - Closed changes: present in the state file but not in the
 *   filesystem. Fires `change.close` with the duration since openedAt
 *   and the original work type.
 *
 * Idempotent: if called twice with no filesystem changes, no events
 * are fired the second time.
 */
export function syncOpenspecChanges(projectRoot: string): void {
  if (!isEnabled()) return
  const state = loadState()
  const currentDirs = findChangeDirs(projectRoot)
  const currentNames = new Set(
    currentDirs.map((d) => d.split('/').pop()!).filter(Boolean)
  )

  // 1. New changes
  for (const dir of currentDirs) {
    const name = dir.split('/').pop()!
    if (state.lastSeenChanges[name]) continue
    const proposalPath = join(dir, 'proposal.md')
    const { workType, title, estimateMin, estimateBucket } =
      readProposalFrontmatter(proposalPath)
    track({
      event_type: 'change.open',
      project: 'default',
      payload: {
        changeName: name,
        workType,
        title,
        ...(estimateMin !== undefined
          ? { estimateMin, estimateSource: 'per-change' as const, estimateBucket }
          : {}),
      },
    })
    state.lastSeenChanges[name] = {
      openedAt: Date.now(),
      workType,
      title,
      estimateMin,
      estimateBucket,
    }
  }

  // 2. Closed changes
  for (const name of Object.keys(state.lastSeenChanges)) {
    if (currentNames.has(name)) continue
    const meta = state.lastSeenChanges[name]
    if (!meta) continue
    const durationMs = Date.now() - meta.openedAt
    track({
      event_type: 'change.close',
      project: 'default',
      payload: {
        changeName: name,
        workType: meta.workType,
        totalCommits: 0, // updated by commits later; or fetched by aggregation
        durationMs,
        verdict: 'unknown',
      },
    })
    delete state.lastSeenChanges[name]
  }

  try {
    saveState(state)
  } catch (err) {
    // Best-effort: if the state file can't be written (e.g. HOME is
    // read-only), the next sync will re-detect the same changes and
    // re-fire events. The tracker is idempotent on a re-scan because
    // the openspec-state.json file is just an optimization.
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[baseline-cloud-client] saveState failed: ${msg}\n`)
  }
}
