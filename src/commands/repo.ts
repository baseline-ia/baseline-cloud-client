import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { logger } from '../logger'
import { syncSkills } from '../skills-sync'
import { syncRepoPolicyForWorkspace } from '../repo-policy'
import { resolveProjectIdentity } from '../project-identity'

interface RepoConfig {
  version?: number
  skills?: { disabled?: string[] }
}

function loadConfig(cwd: string): RepoConfig {
  const p = join(cwd, '.baseline', 'config.json')
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as RepoConfig
  } catch {
    return {}
  }
}

function saveConfig(cwd: string, cfg: RepoConfig): void {
  const dir = join(cwd, '.baseline')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}

function ensureGitignore(cwd: string): void {
  const p = join(cwd, '.baseline', '.gitignore')
  if (!existsSync(p)) {
    writeFileSync(p, 'config.local.json\n', 'utf8')
  }
}

async function promptToggle(rl: ReturnType<typeof createInterface>, prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => {
      resolve(ans.trim().toLowerCase() !== 'n')
    })
  })
}

async function promptList(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string[]> {
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => {
      const items = ans
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      resolve(items)
    })
  })
}

export async function repoInit(cwd: string): Promise<void> {
  const existing = loadConfig(cwd)
  const currentDisabled = existing.skills?.disabled ?? []

  logger.info('baseline-cloud repo init')
  logger.dim(`  Project: ${cwd}`)
  if (currentDisabled.length > 0) {
    logger.dim(`  Currently disabled skills: ${currentDisabled.join(', ')}`)
  }
  logger.dim('')

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  let disabled: string[]
  try {
    const useCustom = await promptToggle(
      rl,
      'Do you want to disable specific skills for this repo? (Y/n): '
    )

    if (!useCustom) {
      disabled = []
    } else {
      logger.dim('  Enter skill slugs to disable, separated by commas.')
      logger.dim('  Example: sdd-security, conflict-resolver')
      logger.dim('')
      disabled = await promptList(rl, 'Skills to disable: ')
    }
  } finally {
    rl.close()
  }

  const cfg: RepoConfig = {
    version: 1,
    skills: { disabled },
  }
  saveConfig(cwd, cfg)
  ensureGitignore(cwd)

  if (disabled.length === 0) {
    logger.success('✓ .baseline/config.json written — all skills enabled')
  } else {
    logger.success(`✓ .baseline/config.json written — disabled: ${disabled.join(', ')}`)
  }
  logger.dim('  Commit .baseline/config.json to share with your team.')
  logger.dim('  Use .baseline/config.local.json for personal overrides (gitignored).')
}

export async function repoSync(cwd: string): Promise<void> {
  const project = resolveProjectIdentity(cwd)
  logger.dim(`  Syncing policy for project: ${project}`)

  const result = await syncSkills()
  if (result.error) {
    logger.error(result.error)
    return
  }

  syncRepoPolicyForWorkspace(cwd, result.cloudPolicy, project)

  const count = result.cloudPolicy.length
  if (count === 0) {
    logger.success('✓ Policy synced — all skills enabled')
  } else {
    logger.success(`✓ Policy synced — ${count} skill${count !== 1 ? 's' : ''} disabled by admin`)
  }
}
