import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadConfig } from './auth'
import { resolveProjectIdentity } from './project-identity'
import { logger } from './logger'

const KIRO_STEERING_DIR = join(homedir(), '.kiro', 'steering')
const SKILL_PREFIX = 'bl-'

interface SkillRow {
  slug: string
  name: string
  version: number
  content: string
  contentHash: string
  failClosed: boolean
  tool: string | null
}

interface SyncResult {
  written: number
  removed: number
  skipped: number
  cloudPolicy: string[]
  error?: string
}

export async function syncSkills(opts: {
  project?: string
  verbose?: boolean
} = {}): Promise<SyncResult> {
  const cfg = loadConfig()
  if (!cfg) {
    return { written: 0, removed: 0, skipped: 0, cloudPolicy: [], error: 'Not authenticated — run: baseline-cloud cloud login' }
  }

  const project = resolveProjectIdentity(opts.project)

  let skills: SkillRow[]
  let cloudPolicy: string[] = []
  try {
    const res = await fetch(`${cfg.server_url}/api/v1/skills?project=${encodeURIComponent(project)}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>
      const code = (body as any).error_code ?? res.status
      return { written: 0, removed: 0, skipped: 0, cloudPolicy: [], error: `Server returned ${res.status} (${code})` }
    }
    const data = await res.json() as { ok: boolean; skills: SkillRow[]; policy?: { skills?: { disabled?: string[] } } }
    skills = data.skills ?? []
    cloudPolicy = data.policy?.skills?.disabled ?? []
  } catch (err) {
    return { written: 0, removed: 0, skipped: 0, cloudPolicy: [], error: `Network error: ${err instanceof Error ? err.message : String(err)}` }
  }

  if (!existsSync(KIRO_STEERING_DIR)) {
    return { written: 0, removed: 0, skipped: 0, cloudPolicy, error: `~/.kiro/steering not found — is Kiro installed?` }
  }

  // Track which files we write so we can remove stale ones.
  const written: string[] = []
  let writeCount = 0
  let skipCount = 0

  for (const skill of skills) {
    const filename = `${SKILL_PREFIX}${skill.slug}.md`
    const dest = join(KIRO_STEERING_DIR, filename)
    writeFileSync(dest, skill.content, 'utf8')
    written.push(filename)
    writeCount++
    if (opts.verbose) logger.success(`  ✓ ${filename} (v${skill.version})`)
  }

  // Remove files we previously wrote that are no longer in the response.
  const stale = readdirSync(KIRO_STEERING_DIR)
    .filter((f) => f.startsWith(SKILL_PREFIX) && !written.includes(f))

  for (const f of stale) {
    unlinkSync(join(KIRO_STEERING_DIR, f))
    if (opts.verbose) logger.dim(`  ✗ removed stale: ${f}`)
  }

  return { written: writeCount, removed: stale.length, skipped: skipCount, cloudPolicy }
}
