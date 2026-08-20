#!/usr/bin/env node
import { Command } from 'commander'
import { buildCloudCommand, buildKiroCommand, buildProjectCommand, buildUpdateCommand } from './index'
import { setup } from './commands/setup'
import { repoInit, repoSync } from './commands/repo'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json') as { version: string; description: string }

const program = new Command()

program
  .name('baseline-cloud')
  .description(pkg.description)
  .version(pkg.version)

program.addCommand(buildCloudCommand())
program.addCommand(buildKiroCommand())
program.addCommand(buildProjectCommand())
program.addCommand(buildUpdateCommand())

program
  .command('setup')
  .description('Detect installed AI tools and configure telemetry hooks automatically')
  .action(async () => {
    await setup()
  })

const repoCmd = program
  .command('repo')
  .description('Manage per-repository skill policy')

repoCmd
  .command('init')
  .description('Configure which skills are disabled for this repository')
  .option('--cwd <dir>', 'Working directory', process.cwd())
  .action(async (opts: { cwd: string }) => {
    await repoInit(opts.cwd)
  })

repoCmd
  .command('sync')
  .description('Fetch cloud policy and write steering file for this repository')
  .option('--cwd <dir>', 'Working directory', process.cwd())
  .action(async (opts: { cwd: string }) => {
    await repoSync(opts.cwd)
  })

program.parse(process.argv)
