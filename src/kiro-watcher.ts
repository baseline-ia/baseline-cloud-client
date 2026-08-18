import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { logger } from './logger'

const LABEL = 'ia.baseline.kiro-scan'
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const CRON_MARKER = '# baseline-cloud kiro-scan'
const SCAN_INTERVAL = 300 // 5 minutes

function findBinary(): string | null {
  const result = spawnSync('which', ['baseline-cloud'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function buildPlist(binaryPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
    <string>kiro</string>
    <string>scan</string>
  </array>
  <key>StartInterval</key>
  <integer>${SCAN_INTERVAL}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/baseline-cloud-kiro.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/baseline-cloud-kiro-error.log</string>
</dict>
</plist>
`
}

// ---------- macOS launchd ----------

function installMacos(binaryPath: string): boolean {
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  spawnSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' })
  writeFileSync(PLIST_PATH, buildPlist(binaryPath), 'utf8')
  const r = spawnSync('launchctl', ['load', PLIST_PATH], { encoding: 'utf8' })
  return r.status === 0
}

function uninstallMacos(): boolean {
  if (!existsSync(PLIST_PATH)) return true
  spawnSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' })
  try { unlinkSync(PLIST_PATH); return true } catch { return false }
}

// ---------- Linux cron ----------

function readCrontab(): string {
  const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout : ''
}

function writeCrontab(content: string): boolean {
  const r = spawnSync('crontab', ['-'], { input: content, encoding: 'utf8' })
  return r.status === 0
}

function installCron(binaryPath: string): boolean {
  const current = readCrontab()
  if (current.includes(CRON_MARKER)) return true
  const entry = `${CRON_MARKER}\n*/5 * * * * ${binaryPath} kiro scan >> /tmp/baseline-cloud-kiro.log 2>&1\n`
  return writeCrontab((current.trimEnd() ? current.trimEnd() + '\n' : '') + entry)
}

function uninstallCron(): boolean {
  const current = readCrontab()
  if (!current.includes(CRON_MARKER)) return true
  const filtered = current
    .split('\n')
    .filter((line, i, arr) => !line.includes(CRON_MARKER) && !arr[i - 1]?.includes(CRON_MARKER))
    .join('\n')
  return writeCrontab(filtered)
}

// ---------- Public API ----------

export function installKiroWatcher(): boolean {
  const binary = findBinary()
  if (!binary) {
    logger.warn('  baseline-cloud binary not found in PATH — skipping watcher install')
    return false
  }

  const os = platform()
  if (os === 'darwin') {
    const ok = installMacos(binary)
    if (ok) logger.success('  ✓ Kiro background scanner installed (launchd, every 5 min)')
    else logger.warn(`  Could not load launchd agent — run: launchctl load ${PLIST_PATH}`)
    return ok
  }
  if (os === 'linux') {
    const ok = installCron(binary)
    if (ok) logger.success('  ✓ Kiro background scanner installed (cron, every 5 min)')
    else logger.warn('  Could not install cron entry')
    return ok
  }

  logger.dim('  · Automatic watcher not supported on this platform (macOS/Linux only)')
  return false
}

export function uninstallKiroWatcher(): boolean {
  const os = platform()
  if (os === 'darwin') {
    const ok = uninstallMacos()
    if (ok) logger.success('  ✓ Kiro background scanner removed')
    return ok
  }
  if (os === 'linux') {
    const ok = uninstallCron()
    if (ok) logger.success('  ✓ Kiro background scanner removed')
    return ok
  }
  return false
}

export function watcherStatus(): { installed: boolean; method: 'launchd' | 'cron' | null } {
  const os = platform()
  if (os === 'darwin') {
    const installed = existsSync(PLIST_PATH)
    return { installed, method: installed ? 'launchd' : null }
  }
  if (os === 'linux') {
    const installed = readCrontab().includes(CRON_MARKER)
    return { installed, method: installed ? 'cron' : null }
  }
  return { installed: false, method: null }
}
