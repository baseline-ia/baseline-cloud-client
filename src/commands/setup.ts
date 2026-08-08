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
  { id: 'kiro',        label: 'Kiro IDE',       dir: '.kiro',           hooksSupported: true  },
  { id: 'kiro-cli',    label: 'Kiro CLI',       binary: 'kiro',         hooksSupported: true  },
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

// ---------- Kiro setup ----------

const KIRO_STEERING_DIR = join(homedir(), '.kiro', 'steering')
const KIRO_STEERING_FILE = join(KIRO_STEERING_DIR, 'baseline-cloud.md')
const KIRO_PERMISSIONS_FILE = join(homedir(), '.kiro', 'settings', 'permissions.yaml')

const KIRO_STEERING_CONTENT = `## baseline-cloud Telemetry

When the user sends a message that starts with \`/skill-name\` (e.g. \`/sdd-new\`, \`/judgment-day\`, \`/branch-pr\`):
1. Extract the skill name (everything after \`/\` up to the first space or end of text, excluding any arguments).
2. Run the following shell command as your FIRST action, before invoking the skill:
   \`\`\`
   baseline-cloud skill track --name <skill-name> --project <current-workspace-dir>
   \`\`\`

For credit/session tracking, run \`baseline-cloud kiro scan\` once at the start of your first turn in a new session.
`

function setupKiroSteering(): boolean {
  const steeringDirExists = existsSync(KIRO_STEERING_DIR)
  if (!steeringDirExists) {
    logger.warn('  ~/.kiro/steering not found — is Kiro installed?')
    return false
  }

  // Write steering file
  writeFileSync(KIRO_STEERING_FILE, KIRO_STEERING_CONTENT, 'utf8')
  logger.success('  ✓ Steering file written: ~/.kiro/steering/baseline-cloud.md')

  // Update permissions.yaml — append a shell rule if not already present
  if (existsSync(KIRO_PERMISSIONS_FILE)) {
    const existing = readFileSync(KIRO_PERMISSIONS_FILE, 'utf8')
    if (existing.includes('baseline-cloud')) {
      logger.dim('  · baseline-cloud shell permission already present')
    } else {
      const addition = [
        '  - capability: shell',
        '    effect: allow',
        '    match:',
        '      - baseline-cloud *',
        '',
      ].join('\n')
      writeFileSync(KIRO_PERMISSIONS_FILE, existing.trimEnd() + '\n' + addition, 'utf8')
      logger.success('  ✓ Shell permission added for baseline-cloud in ~/.kiro/settings/permissions.yaml')
    }
  } else {
    logger.dim('  · permissions.yaml not found — shell permission not added')
  }

  logger.dim('  · Run `baseline-cloud kiro scan` to report credit usage from past sessions')
  return true
}

// ---------- Main ----------

export async function setup(): Promise<void> {
  logger.title('baseline-cloud setup')

  const results: ToolStatus[] = []
  let kiroConfigured = false

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
      } else if ((tool.id === 'kiro' || tool.id === 'kiro-cli') && !kiroConfigured) {
        logger.title('Kiro')
        status.configuredHooks = setupKiroSteering()
        kiroConfigured = true
      } else if ((tool.id === 'kiro' || tool.id === 'kiro-cli') && kiroConfigured) {
        status.configuredHooks = true
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
