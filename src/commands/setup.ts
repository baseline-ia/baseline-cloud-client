import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../logger'

interface ToolStatus {
  name: string
  detected: boolean
  hooksSupported: boolean
  configuredHooks?: boolean
  note?: string
}

const TOOLS = [
  { id: 'claude',      label: 'Claude Code',   binary: 'claude',       hooksSupported: true  },
  { id: 'opencode',    label: 'OpenCode',       binary: 'opencode',     hooksSupported: true  },
  { id: 'kiro',        label: 'Kiro IDE',       dir: '.kiro',           hooksSupported: false, note: 'VS Code-based — no session hooks available yet' },
  { id: 'kiro-cli',    label: 'Kiro CLI',       binary: 'kiro',         hooksSupported: false, note: 'No event hook system available yet' },
  { id: 'antigravity', label: 'Antigravity',    binary: 'antigravity',  hooksSupported: false, note: 'No event hook system available yet' },
  { id: 'commandcode', label: 'CommandCode',    binary: 'commandcode',  hooksSupported: false, note: 'No event hook system available yet' },
] as const

function isInstalled(tool: typeof TOOLS[number]): boolean {
  if ('binary' in tool) {
    try {
      execSync(`command -v ${tool.binary}`, { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  if ('dir' in tool) {
    return existsSync(join(homedir(), tool.dir))
  }
  return false
}

// ---------- Claude Code hook setup ----------

const CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json')

const SKILL_HOOK_COMMAND =
  'skill=$(echo "$CLAUDE_USER_PROMPT" | grep -oE \'^/[a-z][a-z0-9:_-]*\' | sed \'s|^/||\'); [ -n "$skill" ] && baseline-cloud skill track --name "$skill" --project "${CLAUDE_PROJECT_DIR:-$PWD}" || true'

const SESSION_HOOK_COMMAND =
  'INPUT=$(cat); TRANSCRIPT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get(\'transcript_path\',\'\'))" 2>/dev/null); SESSION=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get(\'session_id\',\'\'))" 2>/dev/null); [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] && baseline-cloud session track --transcript "$TRANSCRIPT" --session-id "$SESSION" --project "${CLAUDE_PROJECT_DIR:-$PWD}" || true'

function hookExists(hooks: any[], command: string): boolean {
  return hooks.some((h: any) =>
    h?.hooks?.some((hh: any) => hh?.command === command)
  )
}

function setupClaudeCodeHooks(): boolean {
  if (!existsSync(CLAUDE_SETTINGS)) {
    logger.warn('~/.claude/settings.json not found — is Claude Code installed?')
    return false
  }

  let settings: any
  try {
    settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8'))
  } catch {
    logger.error('Could not parse ~/.claude/settings.json')
    return false
  }

  settings.hooks ??= {}

  // Stop hook — session token tracking
  settings.hooks.Stop ??= []
  if (!hookExists(settings.hooks.Stop, SESSION_HOOK_COMMAND)) {
    settings.hooks.Stop.push({
      hooks: [{ type: 'command', command: SESSION_HOOK_COMMAND }],
      matcher: '',
    })
    logger.success('  ✓ Stop hook added (session token tracking)')
  } else {
    logger.dim('  · Stop hook already present')
  }

  // UserPromptSubmit hook — skill tracking
  settings.hooks.UserPromptSubmit ??= []
  if (!hookExists(settings.hooks.UserPromptSubmit, SKILL_HOOK_COMMAND)) {
    settings.hooks.UserPromptSubmit.push({
      hooks: [{ type: 'command', command: SKILL_HOOK_COMMAND }],
      matcher: '^/',
    })
    logger.success('  ✓ UserPromptSubmit hook added (skill tracking)')
  } else {
    logger.dim('  · UserPromptSubmit hook already present')
  }

  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  return true
}

// ---------- OpenCode plugin setup ----------

const PLUGIN_SRC = join(__dirname, '..', 'opencode-plugin.cjs')
const OPENCODE_PLUGIN_DIR = join(homedir(), '.opencode', 'plugins', 'baseline-cloud')
const OPENCODE_PLUGIN_DEST = join(OPENCODE_PLUGIN_DIR, 'index.cjs')
const OPENCODE_CONFIG = join(homedir(), '.opencode', 'config.json')

function setupOpenCodePlugin(): boolean {
  if (!existsSync(PLUGIN_SRC)) {
    logger.warn('  Could not find OpenCode plugin source — try reinstalling baseline-cloud-client')
    return false
  }

  mkdirSync(OPENCODE_PLUGIN_DIR, { recursive: true })
  copyFileSync(PLUGIN_SRC, OPENCODE_PLUGIN_DEST)
  logger.success('  ✓ Plugin installed at ~/.opencode/plugins/baseline-cloud/index.cjs')

  let config: any = {}
  if (existsSync(OPENCODE_CONFIG)) {
    try {
      config = JSON.parse(readFileSync(OPENCODE_CONFIG, 'utf8'))
    } catch {
      logger.error('  Could not parse ~/.opencode/config.json')
      return false
    }
  }

  config.plugin ??= []
  const pluginEntry: [string, Record<string, unknown>] = [OPENCODE_PLUGIN_DEST, {}]

  const alreadyRegistered = config.plugin.some(
    (p: unknown) => p === OPENCODE_PLUGIN_DEST || (Array.isArray(p) && p[0] === OPENCODE_PLUGIN_DEST)
  )

  if (!alreadyRegistered) {
    config.plugin.push(pluginEntry)
    writeFileSync(OPENCODE_CONFIG, JSON.stringify(config, null, 2) + '\n', 'utf8')
    logger.success('  ✓ Plugin registered in ~/.opencode/config.json')
  } else {
    logger.dim('  · Plugin already registered in ~/.opencode/config.json')
  }

  return true
}

// ---------- Main ----------

export async function setup(): Promise<void> {
  logger.title('baseline-cloud setup')

  const results: ToolStatus[] = []

  for (const tool of TOOLS) {
    const detected = isInstalled(tool)
    const status: ToolStatus = {
      name: tool.label,
      detected,
      hooksSupported: tool.hooksSupported,
      note: 'note' in tool ? tool.note : undefined,
    }

    if (detected && tool.hooksSupported) {
      if (tool.id === 'claude') {
        logger.title('Claude Code')
        status.configuredHooks = setupClaudeCodeHooks()
      } else if (tool.id === 'opencode') {
        logger.title('OpenCode')
        status.configuredHooks = setupOpenCodePlugin()
      }
    }

    results.push(status)
  }

  logger.title('Detection summary')
  for (const r of results) {
    if (!r.detected) {
      logger.dim(`  ○ ${r.name} — not detected`)
      continue
    }
    if (r.hooksSupported) {
      const ok = r.configuredHooks ? '✓' : '✗'
      logger.info(`  ${ok} ${r.name} — hooks ${r.configuredHooks ? 'configured' : 'failed'}`)
    } else {
      logger.info(`  ● ${r.name} — detected (${r.note})`)
    }
  }

  logger.title('Next steps')
  logger.info('  Run `baseline-cloud login` if you haven\'t already.')
  logger.dim('  Hooks fire automatically from now on — no restart needed.')
}
