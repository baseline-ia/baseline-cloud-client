/**
 * Cloud addon: git hook installer.
 *
 * Manages the per-repo post-commit hook that fires `change.commit`
 * events. The hook script lives at `<gitDir>/hooks/post-commit` and
 * is identified by the `HOOK_MARKER` comment so we can detect (and
 * uninstall) only baseline-managed hooks.
 *
 * Hook behavior:
 *   - On every commit, the hook parses the commit metadata
 *     (sha, message, diff stats) and detects whether the commit
 *     touched `openspec/changes/<name>/` (so we can attribute the
 *     commit to a change).
 *   - It calls `baseline hooks fire-commit ...` to send the event.
 *   - If `baseline` is not on PATH, the hook fails silently (the
 *     commit still succeeds; we just lose the event).
 */
import * as childProcess from 'node:child_process'
import {
  existsSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import fs from 'fs-extra'
import { logger } from './logger'
import { track } from './telemetry'
import { getBaselineConfigDir } from './auth'

/**
 * Indirection for `child_process.execSync`. The real implementation
 * is the namespace import (so it's never destructured at module
 * load time, which would defeat vi.spyOn). The test override is
 * a single function variable that tests can replace via
 * `_setExecSyncForTests`.
 */
let _execSyncFn: typeof childProcess.execSync = childProcess.execSync

/**
 * @internal Override the execSync used by git-hooks. Used by tests
 * to mock git invocations without having to actually run git. Pass
 * `null` to restore the real implementation.
 */
export function _setExecSyncForTests(
  fn: ((cmd: string, opts?: childProcess.ExecSyncOptions) => string | Buffer) | null
): void {
  _execSyncFn = fn
    ? (fn as typeof childProcess.execSync)
    : childProcess.execSync
}

/**
 * Run a shell command synchronously, using the (possibly mocked)
 * execSync. Returns the trimmed string output.
 */
function runSync(cmd: string, opts: childProcess.ExecSyncOptions = {}): string {
  const out = _execSyncFn(cmd, opts)
  return typeof out === 'string' ? out : out.toString().trim()
}

const HOOK_MARKER = '# baseline-cli post-commit hook'

/**
 * The hook script body. Generated as a string so we can install it
 * into any git repo without shipping a separate asset file. The
 * script is POSIX shell (sh, not bash) so it works on macOS, Linux,
 * and the Git Bash environment on Windows.
 *
 * The script intentionally uses `|| true` after the `baseline` call
 * so a missing baseline binary (e.g., user has uninstalled the CLI)
 * does not block the commit. The `exit 0` at the end is belt-and-
 * suspenders.
 */
function postCommitScript(): string {
  return `#!/bin/sh
${HOOK_MARKER}
# Auto-installed by the @amsintegra/baseline-cloud-client addon. Do not edit.

# Extract the SDD change name from committed paths using POSIX-compatible tools.
CHANGE_NAME=$(git diff-tree --no-commit-id --name-only -r HEAD | grep -E '^openspec/changes/[^/]+/' | head -1 | cut -d'/' -f3)

# Fire the event. If baseline is not on PATH, this will fail silently.
if command -v baseline >/dev/null 2>&1; then
  baseline hooks fire-commit \\
    --change-name "$CHANGE_NAME" \\
    --sha "$(git rev-parse HEAD)" \\
    --short-sha "$(git rev-parse --short HEAD)" \\
    --message "$(git log -1 --pretty=%B HEAD)" \\
    --files-changed "$(git diff-tree --no-commit-id --name-only -r HEAD | wc -l | tr -d ' ')" \\
    --lines-added "$(git show --stat HEAD | tail -1 | awk '{print $4}')" \\
    --lines-removed "$(git show --stat HEAD | tail -1 | awk '{print $6}')" \\
    --author-email "$(git log -1 --pretty=%ae HEAD)" || true
fi
exit 0
`
}

const GLOBAL_HOOKS_DIR = join(getBaselineConfigDir(), 'hooks')

/**
 * Install the global git hooks directory at `~/.baseline/hooks/` and
 * configure `git config --global core.hooksPath` to point at it.
 * Skipped if the user already has a different `core.hooksPath` set
 * (we don't want to clobber their existing setup).
 */
export async function installGlobalHooks(assetsDir: string): Promise<void> {
  logger.title('Git hooks')

  const sourceHooksDir = join(assetsDir, 'hooks')
  if (!(await fs.pathExists(sourceHooksDir))) {
    logger.warn('No hooks found in package assets — skipping')
    return
  }

  await fs.ensureDir(GLOBAL_HOOKS_DIR)

  const hooks = await fs.readdir(sourceHooksDir)
  for (const hook of hooks) {
    const src = join(sourceHooksDir, hook)
    const dest = join(GLOBAL_HOOKS_DIR, hook)
    await fs.copy(src, dest, { overwrite: true })
    await fs.chmod(dest, 0o755)
  }

  let existingPath = ''
  try {
    existingPath = runSync('git config --global core.hooksPath', { encoding: 'utf-8' }).trim()
  } catch {
    /* not set */
  }

  if (existingPath && existingPath !== GLOBAL_HOOKS_DIR) {
    logger.warn(`core.hooksPath already set to: ${existingPath}`)
    logger.dim('Skipping override — update it manually if you want baseline hooks:')
    logger.dim(`  git config --global core.hooksPath "${GLOBAL_HOOKS_DIR}"`)
    return
  }

  try {
    runSync(`git config --global core.hooksPath "${GLOBAL_HOOKS_DIR}"`, { stdio: 'ignore' })
    logger.success(
      `Global git hooks installed → ${GLOBAL_HOOKS_DIR.replace(getBaselineConfigDir().split('/').slice(0, -1).join('/'), '~')}`
    )
    logger.success('Pre-push protection enabled for all repos')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`Could not configure global git hooks: ${message}`)
  }
}

/** True if the user's global core.hooksPath points at our hooks dir. */
export function isInstalled(): boolean {
  try {
    const hooksPath = runSync('git config --global core.hooksPath', { encoding: 'utf-8' }).trim()
    return hooksPath === GLOBAL_HOOKS_DIR
  } catch {
    return false
  }
}

/** True if the current working directory is inside a git work tree. */
export function isInsideGitRepo(): boolean {
  try {
    runSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Absolute path to the current .git directory, or null if not in a repo. */
export function getGitDir(): string | null {
  try {
    const out = runSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim()
    if (!out) return null
    return out.startsWith('/') ? out : join(process.cwd(), out)
  } catch {
    return null
  }
}

/** True if `<gitDir>/hooks/post-commit` is a baseline-managed hook. */
export function isHookInstalled(): boolean {
  const gitDir = getGitDir()
  if (!gitDir) return false
  const hookPath = join(gitDir, 'hooks', 'post-commit')
  if (!existsSync(hookPath)) return false
  const content = readFileSync(hookPath, 'utf8')
  return content.includes(HOOK_MARKER)
}

/**
 * Install the post-commit hook in the current repo. Returns:
 *   - { installed: true, message } on success
 *   - { installed: false, message } if not in a repo, or git dir
 *     cannot be located
 */
export function installHook(): { installed: boolean; message: string } {
  if (!isInsideGitRepo()) {
    return { installed: false, message: 'Not inside a git repository' }
  }
  const gitDir = getGitDir()
  if (!gitDir) return { installed: false, message: 'Could not find .git directory' }
  const hooksDir = join(gitDir, 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  const hookPath = join(hooksDir, 'post-commit')
  writeFileSync(hookPath, postCommitScript(), { mode: 0o755 })
  chmodSync(hookPath, 0o755)
  return { installed: true, message: `Installed post-commit hook at ${hookPath}` }
}

/**
 * Uninstall the post-commit hook. Refuses to touch hooks that don't
 * carry the HOOK_MARKER (we don't want to delete a user's custom
 * hook).
 */
export function uninstallHook(): { uninstalled: boolean; message: string } {
  const gitDir = getGitDir()
  if (!gitDir) return { uninstalled: false, message: 'No .git directory' }
  const hookPath = join(gitDir, 'hooks', 'post-commit')
  if (!existsSync(hookPath)) {
    return { uninstalled: true, message: 'No hook to remove' }
  }
  const content = readFileSync(hookPath, 'utf8')
  if (!content.includes(HOOK_MARKER)) {
    return {
      uninstalled: false,
      message: 'post-commit hook exists but is not managed by baseline (leaving it alone)',
    }
  }
  unlinkSync(hookPath)
  return { uninstalled: true, message: 'Removed baseline post-commit hook' }
}

export function hookStatus(): { installed: boolean; path: string | null } {
  const gitDir = getGitDir()
  return {
    installed: isHookInstalled(),
    path: gitDir ? join(gitDir, 'hooks', 'post-commit') : null,
  }
}

/**
 * Fire a `change.commit` event. Called by the post-commit hook via
 * `baseline hooks fire-commit ...`. The `opts` are parsed from CLI
 * flags; numeric strings are coerced to numbers.
 */
export function fireCommitEvent(opts: {
  changeName?: string
  sha: string
  shortSha: string
  message: string
  filesChanged: number
  linesAdded: number
  linesRemoved: number
  authorEmail?: string
}): void {
  track({
    event_type: 'change.commit',
    project: 'default',
    payload: opts,
  })
}
