import chalk from 'chalk'

/**
 * Tiny stdout logger for the cloud addon. Mirrors the core CLI's logger
 * (`ams-base-ai/src/utils/logger.ts`) so users see consistent output
 * formatting when the addon's commands run inside the core CLI.
 *
 * The logger writes to stdout. It does NOT log PII, tokens, or secrets.
 */
export const logger = {
  info: (msg: string) => console.log(chalk.cyan('  ℹ'), msg),
  success: (msg: string) => console.log(chalk.green('  ✓'), msg),
  warn: (msg: string) => console.log(chalk.yellow('  ⚠'), msg),
  error: (msg: string) => console.log(chalk.red('  ✗'), msg),
  title: (msg: string) => console.log('\n' + chalk.bold.white(msg)),
  dim: (msg: string) => console.log(chalk.dim('    ' + msg)),
}
