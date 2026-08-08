/**
 * Cloud addon command: `baseline hooks <subcommand>`.
 *
 * Manages the post-commit git hook:
 *
 *   baseline hooks install     Install the hook in the current repo
 *   baseline hooks uninstall   Remove the hook from the current repo
 *   baseline hooks status      Show whether the hook is installed
 *
 *   baseline hooks fire-commit ...   (internal, called by the hook)
 *     Parses CLI flags and fires a `change.commit` event. The hook
 *     itself is a tiny shell script that calls this subcommand on
 *     every commit.
 */
import { logger } from '../logger'
import {
  installHook,
  uninstallHook,
  hookStatus,
  fireCommitEvent,
} from '../git-hooks'

export function hooksInstall(): void {
  const r = installHook()
  if (r.installed) {
    logger.success(`✓ ${r.message}`)
    logger.info(
      '  From now on, every commit will fire a `change.commit` event (only when telemetry is enabled).'
    )
  } else {
    logger.error(`✗ ${r.message}`)
  }
}

export function hooksUninstall(): void {
  const r = uninstallHook()
  if (r.uninstalled) {
    logger.success(`✓ ${r.message}`)
  } else {
    logger.error(`✗ ${r.message}`)
  }
}

export function hooksStatus(): void {
  const s = hookStatus()
  if (s.installed) {
    logger.success(`✓ Hook installed at ${s.path}`)
  } else {
    logger.info(
      `✗ No baseline hook installed${s.path ? ` (other post-commit exists at ${s.path})` : ''}`
    )
    logger.info('  Run `baseline hooks install` to enable automatic commit tracking.')
  }
}

/**
 * Called by the post-commit hook via
 * `baseline hooks fire-commit --change-name X --sha Y ...`.
 * Parses CLI flags and fires the `change.commit` event.
 */
export function hooksFireCommit(opts: {
  changeName?: string
  sha: string
  shortSha: string
  message: string
  filesChanged: string | number
  linesAdded: string | number
  linesRemoved: string | number
  authorEmail?: string
}): void {
  fireCommitEvent({
    changeName: opts.changeName,
    sha: opts.sha,
    shortSha: opts.shortSha,
    message: opts.message,
    filesChanged: Number(opts.filesChanged) || 0,
    linesAdded: Number(opts.linesAdded) || 0,
    linesRemoved: Number(opts.linesRemoved) || 0,
    authorEmail: opts.authorEmail,
  })
}
