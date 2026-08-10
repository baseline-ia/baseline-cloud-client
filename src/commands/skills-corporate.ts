import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { getBaselineConfigDir, loadConfig } from '../auth'
import { getJson } from '../api'
import { logger } from '../logger'
import { resolveProjectIdentity } from '../project-identity'
import { flush, track } from '../telemetry'

const LOCK_VERSION = 1
const NOT_LOGGED_IN = 'Not logged in. Run baseline-cloud cloud login first.'
const LOGICAL_SKILLS_DIRECTORY = '~/.baseline/skills'

type SkillVersion = string | number

function skillsDirectory(): string {
  return join(getBaselineConfigDir(), 'skills')
}

function lockPath(): string {
  return join(skillsDirectory(), 'lock.json')
}

export interface CorporateSkillLockEntry {
  skill_id: string
  version: SkillVersion
  sha256: string
  installed_at: string
  fail_closed: boolean
  path: string
}

export interface CorporateSkillsLock {
  version: number
  synced_at: string
  skills: Record<string, CorporateSkillLockEntry>
}

interface RemoteSkill {
  slug: string
  skill_id?: string
  version: SkillVersion
  content: string
  sha256?: string
  hash?: string
  content_sha256?: string
  contentHash?: string
  fail_closed?: boolean
  failClosed?: boolean
}

interface RemoteSkillsResponse {
  skills?: RemoteSkill[]
  items?: RemoteSkill[]
}

interface VerifyResponse {
  valid?: boolean
  ok?: boolean
  active?: boolean
}

function configOrThrow() {
  const config = loadConfig()
  if (!config) throw new Error(NOT_LOGGED_IN)
  return config
}

function safePart(value: string | number, label: string): string {
  const normalized = String(value)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error(`Invalid corporate skill ${label}.`)
  }
  return normalized
}

function versionPart(value: SkillVersion): string {
  return safePart(value, 'version')
}

function parseRemoteSkills(response: RemoteSkillsResponse | RemoteSkill[] | null): RemoteSkill[] {
  const skills = Array.isArray(response) ? response : response?.skills ?? response?.items ?? []
  return skills.map((skill) => ({
    ...skill,
    slug: safePart(skill.slug, 'slug'),
    version: typeof skill.version === 'number' ? skill.version : safePart(skill.version, 'version'),
  }))
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function atomicWrite(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode })
    chmodSync(temporary, mode)
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true })
  }
}

function readLock(): CorporateSkillsLock | null {
  if (!existsSync(lockPath())) return null
  try {
    const lock = JSON.parse(readFileSync(lockPath(), 'utf8')) as CorporateSkillsLock
    if (lock.version !== LOCK_VERSION || lock.skills === null || typeof lock.skills !== 'object' || Array.isArray(lock.skills)) return null
    return lock
  } catch {
    return null
  }
}

function canonicalDirectory(skill: { slug: string; version: SkillVersion }): string {
  return join(skillsDirectory(), skill.slug, versionPart(skill.version))
}

function logicalSkillPath(slug: string, version: SkillVersion): string {
  return `${LOGICAL_SKILLS_DIRECTORY}/${slug}/${versionPart(version)}/SKILL.md`
}

function replaceReadOnlyFile(destination: string, content: string): void {
  if (existsSync(destination)) chmodSync(destination, 0o644)
  try {
    atomicWrite(destination, content, 0o644)
  } finally {
    if (existsSync(destination)) chmodSync(destination, 0o444)
  }
}

function installCopy(skill: CorporateSkillLockEntry, slug: string, destinationRoot: string, canonical: string): void {
  const destination = join(destinationRoot, 'skills', slug)
  mkdirSync(destination, { recursive: true, mode: 0o755 })
  replaceReadOnlyFile(join(destination, 'SKILL.md'), readFileSync(join(canonical, 'SKILL.md'), 'utf8'))
  replaceReadOnlyFile(join(destination, 'manifest.json'), readFileSync(join(canonical, 'manifest.json'), 'utf8'))
}

function copyToExistingIntegrations(skill: CorporateSkillLockEntry, slug: string, projectDirectory: string, canonical: string): void {
  for (const rootName of ['.claude', '.opencode']) {
    const root = join(projectDirectory, rootName)
    if (existsSync(root) && statSync(root).isDirectory()) installCopy(skill, slug, root, canonical)
  }
}

async function fetchSkills(project: string): Promise<RemoteSkill[]> {
  const config = configOrThrow()
  const response = await getJson<RemoteSkillsResponse | RemoteSkill[]>(
    `${config.server_url}/api/v1/skills?project=${encodeURIComponent(project)}`,
    { Authorization: `Bearer ${config.token}` },
  )
  if (!response.ok || response.json === null) throw new Error(`Could not fetch corporate skills (HTTP ${response.status}).`)
  return parseRemoteSkills(response.json)
}

export function getCorporateSkillsLock(): CorporateSkillsLock | null {
  return readLock()
}

export async function syncCorporateSkills(options: { project?: string; directory?: string } = {}): Promise<void> {
  configOrThrow()
  const project = resolveProjectIdentity(options.project)
  const remoteSkills = await fetchSkills(project)
  const previous = readLock()
  const previousBySlug = previous?.skills ?? {}
  const entries: Record<string, CorporateSkillLockEntry> = {}
  const syncedAt = new Date().toISOString()
  const downloads = remoteSkills.map((skill) => {
    const actualHash = sha256(skill.content)
    const expectedHash = skill.sha256 ?? skill.contentHash ?? skill.content_sha256 ?? skill.hash
    if (!expectedHash || expectedHash.toLowerCase() !== actualHash) {
      throw new Error(`Corporate skill ${skill.slug} failed hash verification.`)
    }
    const entry: CorporateSkillLockEntry = {
      skill_id: skill.skill_id ?? skill.slug,
      version: skill.version,
      sha256: actualHash,
      installed_at: syncedAt,
      fail_closed: skill.fail_closed === true || skill.failClosed === true,
      path: logicalSkillPath(skill.slug, skill.version),
    }
    entries[skill.slug] = entry
    return { skill, entry }
  })

  let synced = 0
  let upToDate = 0
  for (const { skill, entry } of downloads) {
    const slug = skill.slug
    const old = previousBySlug[slug]
    const canonical = canonicalDirectory({ slug, version: entry.version })
    const canonicalFile = join(canonical, 'SKILL.md')
    const unchanged = old?.version === entry.version && old.sha256 === entry.sha256 && existsSync(canonicalFile)
    if (unchanged) {
      upToDate += 1
    } else {
      mkdirSync(canonical, { recursive: true, mode: 0o755 })
      atomicWrite(canonicalFile, skill.content, 0o444)
      atomicWrite(
        join(canonical, 'manifest.json'),
        JSON.stringify({
          skill_id: entry.skill_id,
          version: entry.version,
          sha256: entry.sha256,
          fail_closed: entry.fail_closed,
          synced_at: syncedAt,
        }, null, 2) + '\n',
        0o444,
      )
      chmodSync(canonicalFile, 0o444)
      chmodSync(join(canonical, 'manifest.json'), 0o444)
      synced += 1
    }
    copyToExistingIntegrations(entry, slug, options.directory ?? process.cwd(), canonical)
    if (!unchanged) {
      track({
        event_type: 'skill.installed',
        project,
        payload: { skillName: slug, version: entry.version, scope: 'corporate' },
      })
    }
  }

  atomicWrite(lockPath(), JSON.stringify({ version: LOCK_VERSION, synced_at: syncedAt, skills: entries }, null, 2) + '\n', 0o600)
  await flush()
  logger.success(`Corporate skills: ${synced} synced, ${upToDate} up-to-date.`)
}

export async function statusCorporateSkills(options: { project?: string } = {}): Promise<void> {
  const lock = readLock()
  if (!lock) {
    logger.info('No corporate skills synced. Run baseline-cloud skills sync.')
    return
  }
  const project = resolveProjectIdentity(options.project)
  const available = await fetchSkills(project)
  const installed = lock.skills
  logger.info('Corporate skills')
  logger.info('SLUG\tINSTALLED\tAVAILABLE\tSTATUS')
  for (const skill of available) {
    const local = installed[skill.slug]
    const status = local?.version === skill.version ? 'up-to-date' : local ? 'update available' : 'not installed'
    logger.info(`${skill.slug}\t${local?.version ?? '-'}\t${skill.version}\t${status}`)
  }
}

export async function verifyCorporateSkills(options: { project?: string } = {}): Promise<boolean> {
  const lock = readLock()
  if (!lock) {
    logger.info('No corporate skills synced. Run baseline-cloud skills sync.')
    return true
  }
  const requiresOnlineVerification = Object.values(lock.skills).some((skill) => skill.fail_closed)
  const config = requiresOnlineVerification ? loadConfig() : null
  const project = requiresOnlineVerification ? resolveProjectIdentity(options.project) : null
  const compromised: string[] = []
  for (const [slug, skill] of Object.entries(lock.skills)) {
    const directory = canonicalDirectory({ slug, version: skill.version })
    const contentPath = join(directory, 'SKILL.md')
    const manifestPath = join(directory, 'manifest.json')
    let valid = false
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        skill_id?: string
        version?: SkillVersion
        sha256?: string
        fail_closed?: boolean
        synced_at?: string
      }
      valid = existsSync(contentPath)
        && sha256(readFileSync(contentPath, 'utf8')) === skill.sha256
        && manifest.skill_id === skill.skill_id
        && manifest.version === skill.version
        && manifest.sha256 === skill.sha256
        && manifest.fail_closed === skill.fail_closed
        && typeof manifest.synced_at === 'string'
    } catch {
      valid = false
    }
    if (!valid) {
      compromised.push(slug)
      continue
    }
    if (skill.fail_closed) {
      try {
        if (!config) throw new Error('missing cloud config')
        const response = await getJson<VerifyResponse>(
          `${config.server_url}/api/v1/skills/${encodeURIComponent(slug)}/verify?project=${encodeURIComponent(project ?? '')}`,
          { Authorization: `Bearer ${config.token}` },
          { timeoutMs: 5_000 },
        )
        if (!response.ok || response.json === null) {
          logger.error(`Corporate skill ${slug} requires online verification and the server is unreachable.`)
          return false
        }
        if (response.json.valid === false || response.json.ok === false || response.json.active === false) {
          compromised.push(slug)
        }
      } catch {
        logger.error(`Corporate skill ${slug} requires online verification and the server is unreachable.`)
        return false
      }
    }
  }
  if (compromised.length > 0) {
    logger.error(`Compromised corporate skills: ${compromised.join(', ')}`)
    return false
  }
  logger.success('Corporate skills verification: PASS')
  return true
}

export function warnCorporateSkillDrift(projectDirectory = process.cwd()): void {
  const lock = readLock()
  if (!lock) return
  for (const slug of Object.keys(lock.skills)) {
    for (const rootName of ['.claude', '.opencode']) {
      const skillDirectory = join(projectDirectory, rootName, 'skills', slug)
      if (existsSync(skillDirectory) && statSync(skillDirectory).isDirectory()) {
        logger.warn(`  Corporate skill ${slug} already exists in ${rootName}/skills/${slug}; it will not be overwritten by setup.`)
      }
    }
  }
}

export const corporateSkillsPaths = { lock: lockPath, directory: skillsDirectory }
