#!/usr/bin/env node
import { Command } from 'commander'
import { buildCloudCommand, buildOpenspecCommand, buildHooksCommand, buildSkillCommand, buildSessionCommand, buildKiroCommand } from './index'
import { setup } from './commands/setup'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json') as { version: string; description: string }

const program = new Command()

program
  .name('baseline-cloud')
  .description(pkg.description)
  .version(pkg.version)

program.addCommand(buildCloudCommand())
program.addCommand(buildOpenspecCommand())
program.addCommand(buildHooksCommand())
program.addCommand(buildSkillCommand())
program.addCommand(buildSessionCommand())
program.addCommand(buildKiroCommand())

program
  .command('setup')
  .description('Detect installed AI tools and configure telemetry hooks automatically')
  .action(async () => {
    await setup()
  })

program.parse(process.argv)
