/**
 * Cloud addon command: `baseline status --cloud`.
 *
 * Show the current telemetry connection status. Used by the user to
 * verify they're connected (and which server they're talking to) and
 * by the dashboard's onboarding flow to debug a missing telemetry
 * feed.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../logger'
import { loadConfig, getCloudConfigPath, tokenPrefix } from '../auth'
import { isEnabled, envContext } from '../telemetry'

export function statusCloud(): void {
  const cfg = loadConfig()
  const enabled = isEnabled()
  const ctx = envContext()
  const path = getCloudConfigPath()

  logger.title('baseline-cloud telemetry status')
  if (cfg) {
    logger.info(`  Server:     ${cfg.server_url}`)
    logger.info(`  Token:      ${tokenPrefix(cfg.token)}`)
    logger.info(`  Config:     ${path} ${existsSync(path) ? '✓' : '(missing)'}`)
    logger.info(`  Enabled:    ${enabled ? 'yes' : 'no (BASELINE_TELEMETRY=0 or disabled)'}`)
  } else {
    logger.info('  Not configured. Run `baseline-cloud cloud login` to connect.')
  }
  logger.info(`  Local env:  ${ctx.os} ${ctx.arch}, Node ${ctx.nodeVersion}`)
  // Show the home dir for context (so the user can sanity-check that
  // they're looking at the right user's config).
  logger.info(`  HOME:       ${homedir()}`)
}
