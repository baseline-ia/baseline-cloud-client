/**
 * Cloud addon command: `baseline logout`.
 *
 * Disconnect from the baseline-cloud instance by:
 *   1. Deleting the saved config (server URL + token) from disk
 *   2. Firing a `cli.logout` event so the dashboard can show the user
 *      has disconnected (the event goes through the existing session
 *      token BEFORE the config is cleared)
 *
 * Idempotent: succeeds even if no config exists.
 */
import { logger } from '../logger'
import { clearConfig } from '../auth'
import { track } from '../telemetry'

export async function logout(): Promise<void> {
  clearConfig()
  track({ event_type: 'cli.logout', project: 'default', payload: {} })
  logger.success('✓ Logged out. Telemetry disabled.')
}
