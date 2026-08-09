import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger'

export const PACKAGE_NAME = '@baseline-ia/baseline-cloud-client'

interface ProcessResult {
  status: number | null
  stdout?: string
  error?: Error
}

export type UpdateProcessRunner = (
  command: string,
  args: string[],
  options: { stdio: 'inherit' | ['inherit', 'pipe', 'inherit']; encoding?: 'utf8' },
) => ProcessResult

export function npmExecutable(platform = process.platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm'
}

export function buildNpmInstallArgs(): string[] {
  return ['install', '--global', `${PACKAGE_NAME}@latest`]
}

function runProcess(
  runner: UpdateProcessRunner,
  command: string,
  args: string[],
  options: { stdio: 'inherit' | ['inherit', 'pipe', 'inherit']; encoding?: 'utf8' },
  label = command,
): ProcessResult {
  const result = runner(command, args, options)
  if (result.error) {
    throw new Error(`${label} could not be started: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with status ${result.status ?? 'unknown'}. Retry the command after fixing the reported error.`)
  }
  return result
}

function installedPackageRoot(npmRootOutput: string): string {
  const npmRoot = npmRootOutput.trim()
  if (!npmRoot) throw new Error('npm did not report its global package directory')
  return join(npmRoot, '@baseline-ia', 'baseline-cloud-client')
}

export function update(
  runner: UpdateProcessRunner = spawnSync as unknown as UpdateProcessRunner,
  platform = process.platform,
): void {
  const npm = npmExecutable(platform)

  runProcess(runner, npm, buildNpmInstallArgs(), { stdio: 'inherit' }, 'npm install')

  const rootResult = runProcess(runner, npm, ['root', '--global'], {
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
  }, 'npm global root lookup')
  const packageRoot = installedPackageRoot(rootResult.stdout ?? '')
  const cliPath = join(packageRoot, 'dist', 'cli.js')
  if (!existsSync(cliPath)) {
    throw new Error(`updated package CLI was not found at ${cliPath}`)
  }

  const packageJsonPath = join(packageRoot, 'package.json')
  let version = 'unknown'
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string }
    version = packageJson.version ?? version
  } catch {
    // The install succeeded; version output is optional, but setup must still run.
  }

  runProcess(runner, process.execPath, [cliPath, 'setup'], { stdio: 'inherit' }, 'post-update setup')
  logger.success(`Updated ${PACKAGE_NAME}${version === 'unknown' ? '' : `@${version}`}. Integrations refreshed.`)
  logger.info('Credentials in ~/.baseline/cloud.json and project identity in .baseline/project.json were left unchanged.')
}
