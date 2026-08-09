/**
 * Cloud addon: auth + config.
 *
 * Manages the user's cloud configuration (server URL + bearer token),
 * stored at `~/.baseline/cloud.json` with mode 0600 (owner-only). The
 * token is what authenticates every request the addon makes to the
 * baseline-cloud server.
 *
 * Auth resolution order (first match wins):
 *
 *   1. `BASELINE_CLOUD_URL` + `BASELINE_CLOUD_TOKEN` env vars (for CI
 *      and ephemeral environments where the user doesn't want a
 *      persistent token on disk).
 *   2. `~/.baseline/cloud.json` (written by `baseline-cloud cloud login`).
 *
 * If neither resolves, telemetry is effectively off (the track function
 * short-circuits). The user can run `baseline-cloud cloud login` to enable it.
 *
 * SECURITY:
 *  - The config file is written with mode 0600 (Unix only). On Windows
 *    the mode is ignored, but the file lives in the user's home dir
 *    which is user-private by default.
 *  - `saveConfig` strips any trailing slash from the URL (so the
 *    caller doesn't have to worry about double slashes in requests).
 *  - The token is never logged in clear. Use `tokenPrefix()` to render
 *    a redacted version for display.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/** Resolved cloud config. Returned by loadConfig. */
export interface CloudConfig {
  server_url: string
  token: string
}

const CONFIG_FILE = 'cloud.json'

/**
 * Returns the effective home directory. Defaults to os.homedir(),
 * but can be overridden via _setHomedirForTests for test isolation.
 * Computed on each call (not cached) so test overrides take effect
 * immediately.
 */
function effectiveHomedir(): string {
  return _homedirOverride ?? homedir()
}

/**
 * Returns ~/.baseline/cloud.json, the persistent config path.
 */
export function getCloudConfigPath(): string {
  return join(effectiveHomedir(), '.baseline', CONFIG_FILE)
}

/** Returns ~/.baseline, the parent dir where the config lives. */
export function getBaselineConfigDir(): string {
  return join(effectiveHomedir(), '.baseline')
}

let _config: CloudConfig | null = null
let _homedirOverride: string | null = null

/**
 * Load the cloud config from env vars or the persistent file.
 *
 * Order:
 *   1. BASELINE_CLOUD_URL + BASELINE_CLOUD_TOKEN env vars (if both set)
 *   2. ~/.baseline/cloud.json
 *   3. null (telemetry off)
 *
 * The result is memoized: subsequent calls return the same object. To
 * force a re-read (e.g., after `baseline-cloud cloud login` writes a new config),
 * call `clearConfig()` first.
 */
export function loadConfig(): CloudConfig | null {
  if (_config) return _config

  const envUrl = process.env.BASELINE_CLOUD_URL
  const envToken = process.env.BASELINE_CLOUD_TOKEN
  if (envUrl && envToken) {
    _config = { server_url: stripTrailingSlash(envUrl), token: envToken }
    return _config
  }

  const path = getCloudConfigPath()
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CloudConfig>
      if (parsed.server_url && parsed.token) {
        _config = { server_url: stripTrailingSlash(parsed.server_url), token: parsed.token }
        return _config
      }
    } catch {
      // Corrupted config — ignore and continue without telemetry. The
      // user can run `baseline-cloud cloud login` to overwrite.
    }
  }

  return null
}

/**
 * Save the cloud config to `~/.baseline/cloud.json` (mode 0600 on Unix).
 * Overwrites any existing config. Memoizes the new value in memory.
 */
export function saveConfig(cfg: CloudConfig): void {
  const path = getCloudConfigPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({ server_url: cfg.server_url, token: cfg.token }, null, 2),
    { mode: 0o600 }
  )
  _config = { server_url: stripTrailingSlash(cfg.server_url), token: cfg.token }
}

/**
 * Returns ~/.baseline/cloud.json (alias for getCloudConfigPath,
 * duplicated to keep the existing call sites in other files readable).
 * @deprecated use getCloudConfigPath
 */
export function cloudConfigPath(): string {
  return getCloudConfigPath()
}

/**
 * Clear the in-memory memoization and delete the persistent config.
 * Idempotent: succeeds even if the file does not exist.
 */
export function clearConfig(): void {
  _config = null
  try {
    const path = getCloudConfigPath()
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // ignore — best-effort delete
  }
}

/** @internal Reset the memoized config. Used by tests. */
export function _resetConfigForTests(): void {
  _config = null
}

/** @internal Override the effective home directory. Used by tests. */
export function _setHomedirForTests(dir: string | null): void {
  _homedirOverride = dir
}

/** Strip trailing slashes from a URL so request building is uniform. */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Return a redacted version of the token for display.
 * Example: "abc123def456ghi" -> "abc.***".
 */
export function tokenPrefix(token: string): string {
  const first = token.split('.')[0] ?? token
  return `${first.slice(0, 3)}.***`
}
