import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'

const FALLBACK_PROJECT = 'default'
const PROJECT_CONFIG_DIRECTORY = '.baseline'
const PROJECT_CONFIG_FILE = 'project.json'

export interface ProjectConfig {
  slug: string
}

/** Resolve a project path or explicit name to the server-compatible identity. */
export function resolveProjectIdentity(project?: string): string {
  const value = project?.trim()
  if (!value) return resolveDirectoryIdentity(process.cwd())

  // A simple value is an explicit override, even when a directory with that
  // name happens to exist in the current working directory.
  if (isSimpleProjectName(value)) return normalizeProjectSlug(value)

  return resolveDirectoryIdentity(path.resolve(value))
}

function isSimpleProjectName(value: string): boolean {
  return value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')
}

function resolveDirectoryIdentity(directory: string): string {
  const configuredSlug = readProjectConfig(directory)
  if (configuredSlug) return configuredSlug

  const repositoryName = readRepositoryName(directory)
  return normalizeProjectSlug(repositoryName ?? path.basename(directory))
}

/** Find the nearest repo-local project config, failing on invalid contents. */
function readProjectConfig(directory: string): string | null {
  let current = path.resolve(directory)
  while (true) {
    const configPath = path.join(current, PROJECT_CONFIG_DIRECTORY, PROJECT_CONFIG_FILE)
    if (existsSync(configPath)) {
      try {
        const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<ProjectConfig>
        if (typeof parsed.slug !== 'string') throw new Error('the "slug" field must be a string')
        const slug = normalizeConfiguredSlug(parsed.slug)
        if (!slug) throw new Error('the "slug" field must contain a valid project slug')
        return slug
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`Invalid project config at ${configPath}: ${detail}`)
      }
    }

    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function normalizeConfiguredSlug(value: string): string | null {
  const normalized = normalizeProjectSlug(value)
  return normalized === FALLBACK_PROJECT && value.trim().toLowerCase() !== FALLBACK_PROJECT
    ? null
    : normalized
}

/** Write a repo-local project identity config and return its absolute path. */
export function initProjectConfig(slug: string, directory = process.cwd(), force = false): string {
  const normalized = normalizeConfiguredSlug(slug)
  if (!normalized) throw new Error('Invalid project slug: it must contain at least one letter or number')

  const targetDirectory = path.resolve(directory)
  const configDirectory = path.join(targetDirectory, PROJECT_CONFIG_DIRECTORY)
  const configPath = path.join(configDirectory, PROJECT_CONFIG_FILE)
  if (existsSync(configPath) && !force) {
    throw new Error(`Project config already exists at ${configPath}; use --force to overwrite it`)
  }

  mkdirSync(configDirectory, { recursive: true, mode: 0o700 })
  writeFileSync(configPath, `${JSON.stringify({ slug: normalized }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'w',
  })
  chmodSync(configPath, 0o600)
  return configPath
}

function readRepositoryName(directory: string): string | null {
  try {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) return null
    const origin = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return parseRepositoryName(origin)
  } catch {
    return null
  }
}

function parseRepositoryName(origin: string): string | null {
  if (!origin) return null

  const scpMatch = /^(?:[^@]+@)?(github\.com|bitbucket\.org):[^/]+\/(.+)$/i.exec(origin)
  if (scpMatch?.[1] && scpMatch[2]) return stripRepositorySuffix(scpMatch[2])

  try {
    const url = new URL(origin)
    if (!['github.com', 'bitbucket.org'].includes(url.hostname.toLowerCase())) return null
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return null
    const segments = url.pathname.split('/').filter(Boolean)
    const repository = segments.at(-1)
    return repository ? stripRepositorySuffix(repository) : null
  } catch {
    return null
  }
}

function stripRepositorySuffix(value: string): string {
  return value.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
}

/** Normalize to the slug format accepted by baseline-cloud. */
export function normalizeProjectSlug(value: string): string {
  const ascii = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x00-\x7F]/g, '')
  const slug = ascii
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 128)
    .replace(/^[-_.]+|[-_.]+$/g, '')
  return slug || FALLBACK_PROJECT
}
