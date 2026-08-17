import { postJson, getJson } from './api'
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
  deliverEvents,
  _resetForTests as _telemetryReset,
} from './telemetry'
import type { EventType, WorkType, EventPayload } from './telemetry'
import { login } from './commands/login'
import { logout } from './commands/logout'
import { statusCloud } from './commands/status-cloud'
import { kiroScan } from './commands/kiro'
import { installKiroWatcher, uninstallKiroWatcher, watcherStatus } from './kiro-watcher'
import { syncSkills } from './skills-sync'
import { update } from './commands/update'
import { enrollProject } from './commands/project'
import { Command } from 'commander'
import { resolveProjectIdentity, initProjectConfig } from './project-identity'

export interface PluginContext {
  name: string
  version: string
  configDir: string
  registerCommand: (cmd: Command) => void
  onTelemetry: (handler: (event: TelemetryEventLike) => void | Promise<void>) => void
  getConfig: <T = unknown>(key: string) => Promise<T | null>
  setConfig: <T = unknown>(key: string, value: T) => Promise<void>
  isTelemetryEnabled?: () => boolean
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

const VERSION = '0.1.5'

export function buildCloudCommand(): Command {
  const cloud = new Command('cloud').description(
    'baseline-cloud integration (login, status, flush)'
  )

  cloud
    .command('login')
    .description('Authenticate with a self-hosted baseline-cloud instance')
    .option('--no-input', 'Fail instead of prompting (use env vars)')
    .option('--server <url>', 'Server URL (overrides BASELINE_CLOUD_URL)')
    .option('--token <raw>', 'Raw bearer token (skips username/password flow)')
    .option('--username <name>', 'Username (overrides BASELINE_CLOUD_USERNAME)')
    .option('--password <pwd>', 'Password (overrides BASELINE_CLOUD_PASSWORD)')
    .action(async (opts: any) => {
      await login({
        noInput: opts.input === false,
        serverUrl: opts.server,
        token: opts.token,
        username: opts.username,
        password: opts.password,
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

export function buildProjectCommand(): Command {
  const project = new Command('project').description('Manage repo-local project identity')
  project
    .command('init')
    .description('Write .baseline/project.json for the current project')
    .requiredOption('--slug <slug>', 'Project slug')
    .option('--path <directory>', 'Project directory (defaults to cwd)')
    .option('--force', 'Overwrite an existing project config')
    .action((opts: { slug: string; path?: string; force?: boolean }) => {
      const configPath = initProjectConfig(opts.slug, opts.path ?? process.cwd(), opts.force)
      logger.success(`Project config written to ${configPath}`)
    })
  project
    .command('enroll')
    .description('Enroll the current project in baseline-cloud')
    .option('--slug <slug>', 'Project slug (defaults to repo-local identity)')
    .option('--name <name>', 'Project display name (defaults to the slug)')
    .option('--path <directory>', 'Project directory (defaults to cwd)')
    .action(async (opts: { slug?: string; name?: string; path?: string }) => {
      await enrollProject(opts)
    })
  return project
}

export function buildUpdateCommand(): Command {
  return new Command('update')
    .description('Update the globally installed package and refresh AI integrations')
    .action(() => {
      try {
        update()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`Update failed: ${message}`)
        process.exitCode = 1
      }
    })
}

export function buildKiroCommand(): Command {
  const kiro = new Command('kiro').description(
    'Kiro integration — scan sessions and track credit usage'
  )

  kiro
    .command('scan')
    .description('Scan ~/.kiro/sessions for new credit usage and report to baseline-cloud')
    .option('--dry-run', 'Show what would be tracked without sending')
    .action(async (opts: { dryRun?: boolean }) => {
      await kiroScan({ dryRun: opts.dryRun })
    })

  kiro
    .command('sync')
    .description('Download corporate skills from baseline-cloud and write them to ~/.kiro/steering/')
    .option('--project <slug>', 'Project slug (defaults to current directory)')
    .option('--verbose', 'Show each file written')
    .action(async (opts: { project?: string; verbose?: boolean }) => {
      logger.info('Syncing corporate skills…')
      const result = await syncSkills({ project: opts.project, verbose: opts.verbose })
      if (result.error) {
        logger.error(`  ✗ ${result.error}`)
        process.exit(1)
      }
      logger.success(`  ✓ ${result.written} skill(s) written, ${result.removed} removed`)
    })

  const watch = kiro.command('watch').description('Manage the background Kiro session scanner')

  watch
    .command('install')
    .description('Install the background scanner (launchd on macOS, cron on Linux)')
    .action(() => { installKiroWatcher() })

  watch
    .command('uninstall')
    .description('Remove the background scanner')
    .action(() => { uninstallKiroWatcher() })

  watch
    .command('status')
    .description('Show whether the background scanner is installed')
    .action(() => {
      const { installed, method } = watcherStatus()
      if (installed) logger.success(`✓ Background scanner active (${method})`)
      else logger.dim('  · Background scanner not installed — run: baseline-cloud kiro watch install')
    })

  return kiro
}

export async function register(ctx: PluginContext): Promise<AddonManifest> {
  return registerImpl(ctx)
}

export default async function registerImpl(ctx: PluginContext): Promise<AddonManifest> {
  setCliVersion(ctx.version)

  try {
    ctx.registerCommand(buildCloudCommand())
  } catch (err) {
    logRegistrationError('cloud', err)
  }

  try {
    ctx.registerCommand(buildKiroCommand())
  } catch (err) {
    logRegistrationError('kiro', err)
  }

  try {
    ctx.registerCommand(buildProjectCommand())
  } catch (err) {
    logRegistrationError('project', err)
  }

  try {
    ctx.registerCommand(buildUpdateCommand())
  } catch (err) {
    logRegistrationError('update', err)
  }

  try {
    ctx.onTelemetry(async (event) => {
      try {
        track({
          event_type: event.event_type as EventType,
          project: event.project ? resolveProjectIdentity(event.project) : 'default',
          payload: event.payload ?? {},
        })
      } catch (err) {
        logRegistrationError('telemetry-forward', err)
      }
    })
  } catch (err) {
    logRegistrationError('onTelemetry', err)
  }

  return {
    name: 'baseline-cloud-client',
    version: VERSION,
  }
}

function logRegistrationError(what: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`[baseline-cloud-client] failed to register ${what}: ${msg}\n`)
}

export {
  loadConfig,
  saveConfig,
  clearConfig,
  tokenPrefix,
  track,
  flush,
  isEnabled,
  setEnabled,
  setCliVersion,
  parseEstimate,
  envContext,
  detectTools,
  registerExitFlush,
  deliverEvents,
  resolveProjectIdentity,
  initProjectConfig,
  postJson,
  getJson,
  login,
  logout,
  statusCloud,
  kiroScan,
  installKiroWatcher,
  uninstallKiroWatcher,
  watcherStatus,
  update,
  _telemetryReset,
}

export type { EventType, WorkType, EventPayload } from './telemetry'
export type { CloudConfig } from './auth'
