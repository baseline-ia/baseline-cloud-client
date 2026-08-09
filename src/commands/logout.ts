/**
 * Cloud addon command: `baseline logout`.
 *
 * Disconnect from the baseline-cloud instance by:
 *   1. Revoking the token server-side (POST /api/v1/auth/logout)
 *   2. Firing a `cli.logout` event
 *   3. Deleting the saved config from disk
 *
 * Idempotent: succeeds even if no config exists or server is unreachable.
 */
import { logger } from '../logger'
import { loadConfig, clearConfig } from '../auth'
import { track, flush } from '../telemetry'

export async function logout(): Promise<void> {
  const cfg = loadConfig()

  // Revoke the token server-side before clearing local config.
  if (cfg) {
    try {
      await fetch(`${cfg.server_url}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.token}` },
        signal: AbortSignal.timeout(5_000),
      })
    } catch {
      // Server unreachable — still clear locally.
    }
  }

  track({ event_type: 'cli.logout', project: 'default', payload: {} })
  await flush()
  clearConfig()
  logger.success('✓ Logged out. Telemetry disabled.')
}
