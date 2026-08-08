/**
 * @amsintegra/baseline-cloud-client — addon entry point.
 *
 * The baseline CLI's loader (in `@amsintegra/ams-base-ai/plugins/loader.ts`)
 * does `await import('@amsintegra/baseline-cloud-client')` at startup
 * and calls this default export with a plugin context.
 *
 * This file has THREE responsibilities:
 *
 *   1. Register the addon's manifest (name + version) with the
 *      loader so `baseline status --plugins` can show what loaded.
 *
 *   2. Re-export the public API (login, logout, telemetry, etc.) so
 *      it can be imported programmatically (e.g., by tests or by
 *      other addons that want to extend the cloud integration).
 *
 *   3. WIRE UP THE COMMANDS. The default export is the
 *      addon's `register(ctx)` function. It uses
 *      `ctx.registerCommand(...)` to attach each cloud command
 *      to the host CLI's program, and `ctx.onTelemetry(...)` to
 *      subscribe to the host's `cli.*` events so we can forward
 *      them to the cloud.
 *
 * Why register from the default export (not at module top-level)?
 *   The ctx is passed in by the loader. The register function is the
 *   standard plugin pattern; it's what lets us test the addon in
 *   isolation and gives the host a chance to inspect what the addon
 *   registered before parsing argv.
 *
 * Failure isolation:
 *   If any individual registerCommand/onTelemetry call throws, the
 *   loader catches and records it. The CLI continues with whatever
 *   did succeed.
 */
import { postJson } from './api'
import { loadConfig, saveConfig, clearConfig, tokenPrefix } from './auth'
import type { CloudConfig } from './auth'
import { logger } from './logger'
import {
  track,
  flush,
  isEnabled,
  setEnabled,
  setCliVersion,
  parseEstimate,
  envContext,
  detectTools,
  registerExitFlush,
  _resetForTests as _telemetryReset,
} from './telemetry'
import type { EventType, WorkType, EventPayload } from './telemetry'
import { syncOpenspecChanges, readProposalFrontmatter } from './openspec-tracker'
import {
  installHook,
  uninstallHook,
  hookStatus,
  isHookInstalled,
  isInsideGitRepo,
  fireCommitEvent,
} from './git-hooks'
import { login } from './commands/login'
import { logout } from './commands/logout'
import { statusCloud } from './commands/status-cloud'
import { openspecNew, openspecList, openspecClose, openspecSync } from './commands/openspec'
import { hooksInstall, hooksUninstall, hooksStatus, hooksFireCommit } from './commands/hooks'
import { skillTrack } from './commands/skill'
import { sessionTrack } from './commands/session'
import { kiroScan } from './commands/kiro'
import { Command } from 'commander'

/**
 * Local copies of the plugin API types from
 * `@amsintegra/ams-base-ai/plugins`. We re-declare them here
 * (rather than importing) because:
 *
 *   1. The addon's tsup build needs the type declarations to be
 *      present at build time. Importing the host's plugins module
 *      requires `npm link @amsintegra/ams-base-ai` in the dev
 *      workspace, which is the user-flow we want but not the
 *      developer-flow for a fresh `git clone` of the addon.
 *
 *   2. The plugin API contract is small (5 fields on PluginContext,
 *      2 fields on AddonManifest). Re-declaring keeps the addon
 *      self-contained and easy to publish independently of the host.
 *
 *   3. The shapes here MUST match
 *      `ams-base-ai/src/plugins.ts#PluginContext` and
 *      `ams-base-ai/src/loader.ts#AddonManifest`. Any drift is
 *      caught by the e2e test in WU 5 (next chained PR), which
 *      loads the real addon against a real host and asserts the
 *      contract.
 */
export interface PluginContext {
  name: string
  version: string
  configDir: string
  registerCommand: (cmd: Command) => void
  onTelemetry: (handler: (event: TelemetryEventLike) => void | Promise<void>) => void
  getConfig: <T = unknown>(key: string) => Promise<T | null>
  setConfig: <T = unknown>(key: string, value: T) => Promise<void>
  /**
   * Check whether telemetry is currently enabled globally. Returns
   * false when the host's --no-telemetry flag was passed, or
   * BASELINE_TELEMETRY=0/false is set. Optional: addons that don't
   * care about this can ignore it (the host's emitTelemetry already
   * short-circuits when telemetry is off, so the handler won't fire).
   */
  isTelemetryEnabled?: () => boolean
  /**
   * Enable or disable telemetry globally. Used by the host CLI to
   * implement the --no-telemetry flag. Optional.
   */
  setTelemetryEnabled?: (enabled: boolean) => void
}

export interface AddonManifest {
  name: string
  version: string
}

export interface TelemetryEventLike {
  event_type: string
  project?: string
  payload?: Record<string, unknown>
  timestamp?: string
}

const VERSION = '0.1.0'

/**
 * Build the `cloud` commander subcommand tree. Exposed for testing
 * (so tests can call `program.parse(['node', 'test', ...])` on a
 * real program with the cloud commands attached).
 */
export function buildCloudCommand(): Command {
  const cloud = new Command('cloud').description(
    'baseline-cloud integration (login, status, flush, plugins)'
  )

  cloud
    .command('login')
    .description('Authenticate with a self-hosted baseline-cloud instance')
    .option('--no-input', 'Fail instead of prompting (use env vars)')
    .option('--server <url>', 'Server URL (overrides BASELINE_CLOUD_URL)')
    .option('--username <name>', 'Username (overrides BASELINE_CLOUD_USERNAME)')
    .option('--password <pwd>', 'Password (overrides BASELINE_CLOUD_PASSWORD)')
    .option('--skip-hook-prompt', 'Do not prompt to install the post-commit git hook')
    .action(async (opts: any) => {
      await login({
        noInput: opts.input === false,
        serverUrl: opts.server,
        username: opts.username,
        password: opts.password,
        skipHookPrompt: opts.skipHookPrompt,
      })
    })

  cloud
    .command('logout')
    .description('Disconnect from the baseline-cloud instance')
    .action(async () => {
      await logout()
    })

  cloud
    .command('status')
    .description('Show telemetry connection status')
    .action(() => {
      statusCloud()
    })

  cloud
    .command('flush')
    .description('Force-flush the telemetry queue to the cloud')
    .action(async () => {
      await flush()
      logger.success('✓ Flushed telemetry queue.')
    })

  return cloud
}

/**
 * Build the `openspec` commander subcommand tree.
 */
export function buildOpenspecCommand(): Command {
  const openspec = new Command('openspec').description(
    'Manage OpenSpec changes and track their lifecycle'
  )

  openspec
    .command('new <name>')
    .description('Create a new OpenSpec change directory with a proposal scaffold and fire change.open')
    .option(
      '-t, --type <type>',
      'Work type: feature | migration | new-project | chore | fix | refactor | docs',
      'feature'
    )
    .option(
      '-e, --estimate <value>',
      'Estimated time WITHOUT baseline: small|medium|large|xlarge OR 240 (min) OR 4h OR 4h30m'
    )
    .action(async (name: string, opts: { type?: string; estimate?: string }) => {
      await openspecNew(name, { type: opts.type, estimate: opts.estimate })
    })

  openspec
    .command('list')
    .description('List active and archived OpenSpec changes in the current project')
    .action(async () => {
      await openspecList()
    })

  openspec
    .command('close <name>')
    .description('Archive an OpenSpec change (moves to openspec/changes/archive/) and fire change.close')
    .action(async (name: string) => {
      await openspecClose(name)
    })

  openspec
    .command('sync')
    .description('Scan for new/closed OpenSpec changes and fire the corresponding events')
    .action(() => {
      openspecSync()
    })

  return openspec
}

/**
 * Build the `hooks` commander subcommand tree.
 */
export function buildHooksCommand(): Command {
  const hooks = new Command('hooks').description(
    'Manage the post-commit git hook (auto-fires change.commit)'
  )

  hooks
    .command('install')
    .description('Install the post-commit hook in the current git repository')
    .action(() => hooksInstall())

  hooks
    .command('uninstall')
    .description('Remove the post-commit hook from the current git repository')
    .action(() => hooksUninstall())

  hooks
    .command('status')
    .description('Show whether the post-commit hook is installed')
    .action(() => hooksStatus())

  hooks
    .command('fire-commit')
    .description('(Internal) Fire a change.commit event — called by the post-commit hook')
    .option('--change-name <name>', 'Change name (if commit touched openspec/changes/<name>/)')
    .option('--sha <sha>', 'Full commit SHA')
    .option('--short-sha <shortSha>', 'Short commit SHA')
    .option('--message <message>', 'Commit message')
    .option('--files-changed <n>', 'Number of files changed')
    .option('--lines-added <n>', 'Lines added')
    .option('--lines-removed <n>', 'Lines removed')
    .option('--author-email <email>', 'Author email')
    .action((opts: any) => hooksFireCommit(opts))

  return hooks
}

/**
 * Build the `skill` commander subcommand tree.
 */
export function buildSkillCommand(): Command {
  const skill = new Command('skill').description(
    'Track skill usage events for dashboard analytics'
  )

  skill
    .command('track')
    .description('(Internal) Fire a skill.used event — called by the Claude Code hook')
    .requiredOption('--name <name>', 'Skill name (e.g. sdd-new, sdd-apply)')
    .option('--project <path>', 'Project directory path (defaults to cwd)')
    .option('--duration-ms <ms>', 'Time the skill took to respond (ms)')
    .action((opts: { name: string; project?: string; durationMs?: string }) => {
      skillTrack({
        name: opts.name,
        project: opts.project ?? process.cwd(),
        durationMs: opts.durationMs !== undefined ? Number(opts.durationMs) : undefined,
      })
    })

  return skill
}

/**
 * Build the `session` commander subcommand tree.
 */
export function buildSessionCommand(): Command {
  const session = new Command('session').description(
    'Track session-level token usage and cost'
  )

  session
    .command('track')
    .description('(Internal) Aggregate token usage from a session transcript and fire session.tokens')
    .option('--transcript <path>', 'Path to the Claude Code session JSONL file')
    .option('--session-id <id>', 'Session ID')
    .option('--project <path>', 'Project directory path (defaults to cwd)')
    .option('--input-tokens <n>', 'Input tokens (if not using --transcript)')
    .option('--output-tokens <n>', 'Output tokens (if not using --transcript)')
    .option('--cache-read-tokens <n>', 'Cache read tokens')
    .option('--cache-write-tokens <n>', 'Cache write tokens')
    .action(async (opts: any) => {
      await sessionTrack({
        transcriptPath: opts.transcript,
        sessionId: opts.sessionId,
        project: opts.project ?? process.cwd(),
        inputTokens: opts.inputTokens !== undefined ? Number(opts.inputTokens) : undefined,
        outputTokens: opts.outputTokens !== undefined ? Number(opts.outputTokens) : undefined,
        cacheReadTokens: opts.cacheReadTokens !== undefined ? Number(opts.cacheReadTokens) : undefined,
        cacheWriteTokens: opts.cacheWriteTokens !== undefined ? Number(opts.cacheWriteTokens) : undefined,
      })
    })

  return session
}

/**
 * Build the `kiro` commander subcommand tree.
 */
export function buildKiroCommand(): Command {
  const kiro = new Command('kiro').description(
    'Kiro IDE integration — scan sessions and track credit usage'
  )

  kiro
    .command('scan')
    .description('Scan ~/.kiro/sessions for new credit usage and report to baseline-cloud')
    .option('--dry-run', 'Show what would be tracked without sending')
    .action(async (opts: { dryRun?: boolean }) => {
      await kiroScan({ dryRun: opts.dryRun })
    })

  return kiro
}

/**
 * The default export is the loader's contract. The host CLI does
 * `const addon = (await import('@amsintegra/baseline-cloud-client')).default`
 * and calls it with a plugin context.
 *
 * We register four things in this function:
 *
 *   1. The `cloud` subcommand (login, logout, status, flush).
 *   2. The `openspec` subcommand (new, list, close, sync).
 *   3. The `hooks` subcommand (install, uninstall, status, fire-commit).
 *   4. A telemetry handler that forwards every `cli.*` event from the
 *      host CLI to the configured cloud server.
 *
 * All registrations are best-effort: if one throws, the loader
 * catches and records it. The other registrations still run.
 */
// Also export the register function under its name (in addition to
// being the default export) so consumers can do:
//   import { register } from '@amsintegra/baseline-cloud-client'
// without needing the default-import dance.
export async function register(ctx: PluginContext): Promise<AddonManifest> {
  return registerImpl(ctx)
}

export default async function registerImpl(ctx: PluginContext): Promise<AddonManifest> {
  setCliVersion(ctx.version)

  // Cloud subcommand
  try {
    ctx.registerCommand(buildCloudCommand())
  } catch (err) {
    logRegistrationError('cloud', err)
  }

  // OpenSpec subcommand
  try {
    ctx.registerCommand(buildOpenspecCommand())
  } catch (err) {
    logRegistrationError('openspec', err)
  }

  // Hooks subcommand
  try {
    ctx.registerCommand(buildHooksCommand())
  } catch (err) {
    logRegistrationError('hooks', err)
  }

  // Skill tracking subcommand
  try {
    ctx.registerCommand(buildSkillCommand())
  } catch (err) {
    logRegistrationError('skill', err)
  }

  // Session token tracking subcommand
  try {
    ctx.registerCommand(buildSessionCommand())
  } catch (err) {
    logRegistrationError('session', err)
  }

  // Kiro session scan subcommand
  try {
    ctx.registerCommand(buildKiroCommand())
  } catch (err) {
    logRegistrationError('kiro', err)
  }

  // Telemetry forwarder. Every event the host CLI emits (cli.install,
  // cli.update, etc.) is forwarded to the cloud via the addon's own
  // track function. The host's `emitTelemetry` is the upstream
  // contract; the addon's `track` is the downstream sink.
  //
  // Two safety nets ensure the addon never sends events when it
  // shouldn't:
  //
  //  1. The host's emitTelemetry short-circuits if --no-telemetry or
  //     BASELINE_TELEMETRY=0 was set, so this handler is never called.
  //  2. The addon's track() short-circuits if its own isEnabled()
  //     returns false (which checks the same env vars independently).
  //     Belt-and-suspenders in case the host's gate is bypassed.
  try {
    ctx.onTelemetry(async (event) => {
      // Translate the host's plugin API event to the addon's
      // telemetry format. The host emits with `event_type` (string)
      // and `payload` (object). The addon expects the same shape.
      try {
        track({
          event_type: event.event_type as EventType,
          project: event.project ?? 'default',
          payload: event.payload ?? {},
        })
      } catch (err) {
        // Swallow — the host's emitTelemetry already wraps this in
        // a try/catch, but we belt-and-suspender here too.
        logRegistrationError('telemetry-forward', err)
      }
    })
  } catch (err) {
    logRegistrationError('onTelemetry', err)
  }

  // Best-effort: scan for openspec changes on every CLI run. This
  // was previously called by the host's withTelemetry wrapper; the
  // addon now takes ownership of the openspec scanning.
  try {
    syncOpenspecChanges(process.cwd())
  } catch {
    // ignore — non-git projects are fine
  }

  return {
    name: 'baseline-cloud-client',
    version: VERSION,
  }
}

function logRegistrationError(what: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)
  // We write to stderr (not the host's logger) so the message is
  // visible regardless of how the host CLI is configured.
  process.stderr.write(`[baseline-cloud-client] failed to register ${what}: ${msg}\n`)
}

// ---------- Public API re-exports ----------
// These are re-exported so consumers can do:
//   import { login, telemetry } from '@amsintegra/baseline-cloud-client'

export {
  // auth
  loadConfig,
  saveConfig,
  clearConfig,
  tokenPrefix,
  // telemetry
  track,
  flush,
  isEnabled,
  setEnabled,
  setCliVersion,
  parseEstimate,
  envContext,
  detectTools,
  registerExitFlush,
  // openspec-tracker
  syncOpenspecChanges,
  readProposalFrontmatter,
  // git-hooks
  installHook,
  uninstallHook,
  hookStatus,
  isHookInstalled,
  isInsideGitRepo,
  fireCommitEvent,
  // api
  postJson,
  // commands (also exposed for programmatic use)
  login,
  logout,
  statusCloud,
  openspecNew,
  openspecList,
  openspecClose,
  openspecSync,
  hooksInstall,
  hooksUninstall,
  hooksStatus,
  hooksFireCommit,
  // skill tracking
  skillTrack,
  // kiro integration
  kiroScan,
  // test helpers
  _telemetryReset,
}

export type { EventType, WorkType, EventPayload } from './telemetry'
export type { CloudConfig } from './auth'
