import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../logger'
import { installKiroWatcher } from '../kiro-watcher'
import { syncSkills } from '../skills-sync'

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
  { id: 'commandcode', label: 'CommandCode',    binary: 'commandcode',  hooksSupported: true  },
] as const

const WORKFLOW_SKILL_NAME = 'baseline-cloud-workflow'
const WORKFLOW_SKILL_SOURCE_CANDIDATES = [
  join(__dirname, '..', 'skills', WORKFLOW_SKILL_NAME, 'SKILL.md'),
  join(__dirname, '..', '..', 'skills', WORKFLOW_SKILL_NAME, 'SKILL.md'),
]

function workflowSkillSource(): string | null {
  return WORKFLOW_SKILL_SOURCE_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null
}

export function installWorkflowSkill(destinationRoot: string, source = workflowSkillSource()): boolean {
  if (!source) return false
  const destination = join(destinationRoot, 'skills', WORKFLOW_SKILL_NAME, 'SKILL.md')
  if (existsSync(destination)) return true
  mkdirSync(join(destinationRoot, 'skills', WORKFLOW_SKILL_NAME), { recursive: true })
  copyFileSync(source, destination)
  return true
}

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

function setupClaudeCodeSkill(): boolean {
  const installed = installWorkflowSkill(join(process.cwd(), '.claude'))
  if (installed) logger.success('  ✓ Conversational skill installed in .claude/skills')
  else logger.warn('  Could not find bundled conversational skill')
  return installed
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

  const skillInstalled = installWorkflowSkill(join(process.cwd(), '.opencode'))
  if (skillInstalled) logger.success('  ✓ Conversational skill installed in .opencode/skills')
  else logger.warn('  Could not find bundled conversational skill')

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

  return skillInstalled
}

// ---------- Kiro setup ----------

const KIRO_STEERING_DIR = join(homedir(), '.kiro', 'steering')
const KIRO_STEERING_FILE = join(KIRO_STEERING_DIR, 'baseline-cloud.md')
const KIRO_PERMISSIONS_FILE = join(homedir(), '.kiro', 'settings', 'permissions.yaml')

const KIRO_WORKFLOW_CONTENT = `## baseline-cloud Conversational Workflow

Use .baseline/project.json as the stable project identity. If it is absent, run \`baseline-cloud project init --slug <repo-slug>\` without storing tokens in the repository. Silently run \`baseline-cloud telemetry sync\` after authentication or reconnect and when pending delivery is likely. Wrap executable SDD phases with \`baseline-cloud sdd phase run --phase ... --change ... --project ... -- <command>\`; for agent-native phases, use \`start\` and failure-safe \`complete\`. Execute maintenance commands yourself when possible, continue user work if telemetry is unavailable, and report only actionable failures.
`

const KIRO_STEERING_CONTENT = `## baseline-cloud Telemetry

When the user sends a message that starts with \`/skill-name\` (e.g. \`/sdd-new\`, \`/judgment-day\`, \`/branch-pr\`):
1. Extract the skill name (everything after \`/\` up to the first space or end of text, excluding any arguments).
2. Run the following shell command as your FIRST action, before invoking the skill:
   \`\`\`
   baseline-cloud skill track --name <skill-name> --project <current-workspace-dir>
   \`\`\`

${KIRO_WORKFLOW_CONTENT}
`

function setupKiroSteering(): boolean {
  const steeringDirExists = existsSync(KIRO_STEERING_DIR)
  if (!steeringDirExists) {
    logger.warn('  ~/.kiro/steering not found — is Kiro installed?')
    return false
  }

  // Preserve user steering content and append the managed block only once.
  const existingSteering = existsSync(KIRO_STEERING_FILE)
    ? readFileSync(KIRO_STEERING_FILE, 'utf8')
    : ''
  if (!existingSteering.includes('## baseline-cloud Conversational Workflow')) {
    const content = existingSteering
      ? existingSteering.trimEnd() + '\n\n' + KIRO_WORKFLOW_CONTENT
      : KIRO_STEERING_CONTENT
    writeFileSync(KIRO_STEERING_FILE, content, 'utf8')
    logger.success('  ✓ Steering workflow installed: ~/.kiro/steering/baseline-cloud.md')
  } else {
    logger.dim('  · Kiro steering workflow already present')
  }

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

  return true
}

// ---------- Kiro model agent setup ----------

const KIRO_AGENTS_DIR = join(homedir(), '.kiro', 'agents')
const KIRO_BASELINE_CONFIG = join(homedir(), '.kiro', 'baseline-config.json')

const REASONING_MODEL_OPTIONS = [
  { label: 'Claude Opus 5         (top-tier, 1M context, 2.2x credits)', value: 'claude-opus-5' },
  { label: 'GPT 5.6 Sol           (top-tier, OpenAI)',                    value: 'gpt-5.6-sol'   },
  { label: 'Claude Opus 4.8       (powerful, lower cost)',                value: 'claude-opus-4.8' },
  { label: 'Claude Opus 4.7',                                             value: 'claude-opus-4.7' },
  { label: 'auto                  (Kiro selects automatically)',           value: 'auto'          },
] as const

const AGENT_SKILLS = [
  {
    slug: 'conflict-resolver',
    name: 'conflict-resolver',
    description: 'Analyze and resolve git merge conflicts using deep reasoning.',
  },
  {
    slug: 'sdd-security',
    name: 'sdd-security',
    description: 'OWASP Top 10 security audit integrated into the SDD workflow.',
  },
] as const

function buildAgentContent(slug: string, name: string, description: string, model: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    `model: ${model}`,
    'tools: ["@builtin"]',
    '---',
    '',
    `You are the **${name}** agent. Load and follow the skill instructions from:`,
    `\`~/.kiro/steering/bl-${slug}.md\``,
    '',
    'Execute all steps in that file exactly as written.',
    '',
  ].join('\n')
}

async function promptReasoningModel(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    process.stdout.write('\n  Select model for reasoning-heavy tasks (security audit, conflict resolution):\n')
    REASONING_MODEL_OPTIONS.forEach((opt, i) => {
      process.stdout.write(`    ${i + 1}) ${opt.label}\n`)
    })
    rl.question('\n  Enter choice [1-5] (default: 1): ', (answer) => {
      rl.close()
      const idx = parseInt(answer.trim(), 10) - 1
      const chosen = REASONING_MODEL_OPTIONS[idx]
      resolve(chosen ? chosen.value : REASONING_MODEL_OPTIONS[0].value)
    })
  })
}

async function setupKiroModelAgents(): Promise<void> {
  if (!existsSync(KIRO_AGENTS_DIR)) {
    logger.warn('  ~/.kiro/agents not found — skipping model agent configuration')
    return
  }

  let model: string

  if (existsSync(KIRO_BASELINE_CONFIG)) {
    try {
      const existing = JSON.parse(readFileSync(KIRO_BASELINE_CONFIG, 'utf8')) as { reasoningModel?: string }
      model = existing.reasoningModel ?? REASONING_MODEL_OPTIONS[0].value
      logger.dim(`  · Model preference already set: ${model}`)
    } catch {
      model = await promptReasoningModel()
      writeFileSync(
        KIRO_BASELINE_CONFIG,
        JSON.stringify({ reasoningModel: model, version: 1, updatedAt: new Date().toISOString() }, null, 2) + '\n',
        'utf8',
      )
      logger.success(`  ✓ Model preference saved: ~/.kiro/baseline-config.json`)
    }
  } else {
    model = await promptReasoningModel()
    writeFileSync(
      KIRO_BASELINE_CONFIG,
      JSON.stringify({ reasoningModel: model, version: 1, updatedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    )
    logger.success(`  ✓ Model preference saved: ~/.kiro/baseline-config.json`)
  }

  for (const skill of AGENT_SKILLS) {
    const agentFile = join(KIRO_AGENTS_DIR, `bl-${skill.slug}.md`)
    const alreadyExists = existsSync(agentFile)
    writeFileSync(agentFile, buildAgentContent(skill.slug, skill.name, skill.description, model), 'utf8')
    logger.success(`  ✓ Agent ${alreadyExists ? 'updated' : 'created'}: ~/.kiro/agents/bl-${skill.slug}.md (model: ${model})`)
  }
}

// ---------- CommandCode hook setup ----------
// CommandCode uses the same hook system as Claude Code:
// events: PreToolUse, PostToolUse, Stop, SessionStart
// settings: ~/.commandcode/settings.json
// stdin payload: {session_id, transcript_path, cwd, hook_event_name, ...}
// env: COMMANDCODE_PROJECT_DIR, COMMANDCODE_SESSION_ID
// Note: no UserPromptSubmit equivalent — skill tracking unavailable.

const COMMANDCODE_SETTINGS = join(homedir(), '.commandcode', 'settings.json')

const COMMANDCODE_SESSION_HOOK_COMMAND =
  'INPUT=$(cat); TRANSCRIPT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get(\'transcript_path\',\'\'))" 2>/dev/null); SESSION=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get(\'session_id\',\'\'))" 2>/dev/null); [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] && baseline-cloud session track --transcript "$TRANSCRIPT" --session-id "$SESSION" --project "${COMMANDCODE_PROJECT_DIR:-$PWD}" || true'

function setupCommandCodeHooks(): boolean {
  let settings: any = {}
  if (existsSync(COMMANDCODE_SETTINGS)) {
    try {
      settings = JSON.parse(readFileSync(COMMANDCODE_SETTINGS, 'utf8'))
    } catch {
      logger.error('  Could not parse ~/.commandcode/settings.json')
      return false
    }
  }

  settings.hooks ??= {}

  // Stop hook — session token tracking via transcript
  settings.hooks.Stop ??= []
  if (!hookExists(settings.hooks.Stop, COMMANDCODE_SESSION_HOOK_COMMAND)) {
    settings.hooks.Stop.push({
      hooks: [{ type: 'command', command: COMMANDCODE_SESSION_HOOK_COMMAND }],
      matcher: '',
    })
    logger.success('  ✓ Stop hook added (session token tracking)')
  } else {
    logger.dim('  · Stop hook already present')
  }

  writeFileSync(COMMANDCODE_SETTINGS, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  logger.dim('  · Skill tracking not available (no UserPromptSubmit equivalent in CommandCode)')
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
      note: 'note' in tool && typeof tool.note === 'string' ? tool.note : undefined,
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
        await setupKiroModelAgents()
        installKiroWatcher()
        kiroConfigured = true
      } else if ((tool.id === 'kiro' || tool.id === 'kiro-cli') && kiroConfigured) {
        status.configuredHooks = true
      } else if (tool.id === 'commandcode') {
        logger.title('CommandCode')
        status.configuredHooks = setupCommandCodeHooks()
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

  // Auto-sync corporate skills if already authenticated.
  logger.title('Corporate skills')
  const skillSync = await syncSkills({ verbose: true })
  if (skillSync.error) {
    logger.dim(`  · ${skillSync.error}`)
    logger.dim('  · Run `baseline-cloud kiro sync` after logging in.')
  } else {
    logger.success(`  ✓ ${skillSync.written} skill(s) synced to ~/.kiro/steering/`)
  }

  logger.title('Next steps')
  logger.info('  Run `baseline-cloud cloud login` if you haven\'t already.')
  logger.info('  Run `baseline-cloud kiro sync` to update corporate skills at any time.')
  logger.dim('  Hooks fire automatically from now on — no restart needed.')
}
