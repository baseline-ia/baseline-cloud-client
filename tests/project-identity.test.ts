import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'fs-extra'
import os from 'os'
import path from 'path'

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-client-identity-'))
})

afterEach(async () => {
  await fs.remove(tmpRoot)
  vi.restoreAllMocks()
  delete process.env.BASELINE_CLOUD_URL
  delete process.env.BASELINE_CLOUD_TOKEN
})

async function repo(origin?: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpRoot, 'repo-'))
  execFileSync('git', ['init', '--quiet'], { cwd: directory })
  if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: directory })
  return directory
}

describe('project identity', () => {
  it.each([
    ['https://github.com/baseline-ia/baseline-cloud-client.git', 'baseline-cloud-client'],
    ['git@github.com:baseline-ia/baseline-cloud-client.git', 'baseline-cloud-client'],
    ['https://bitbucket.org/workspace/cloud_client.git?tab=overview#readme', 'cloud_client'],
  ])('resolves repository name from %s', async (origin, expected) => {
    const { resolveProjectIdentity } = await import('../src/project-identity')
    expect(resolveProjectIdentity(await repo(origin))).toBe(expected)
  })

  it('strips .git and falls back to the folder basename', async () => {
    const { resolveProjectIdentity } = await import('../src/project-identity')
    const directory = await fs.mkdtemp(path.join(tmpRoot, 'folder-fallback-'))
    expect(resolveProjectIdentity(directory)).toBe(path.basename(directory).toLowerCase())
    expect(resolveProjectIdentity(await repo('https://github.com/org/name.git/'))).toBe('name')
  })

  it('falls back quietly for an invalid or missing origin', async () => {
    const { resolveProjectIdentity } = await import('../src/project-identity')
    const invalid = await repo('https://example.com/org/not-supported.git')
    const missing = await repo()
    expect(resolveProjectIdentity(invalid)).toBe(path.basename(invalid).toLowerCase())
    expect(resolveProjectIdentity(missing)).toBe(path.basename(missing).toLowerCase())
  })

  it('preserves an explicit override as a normalized slug', async () => {
    const { resolveProjectIdentity } = await import('../src/project-identity')
    expect(resolveProjectIdentity('Baseline Cloud Client')).toBe('baseline-cloud-client')
    expect(resolveProjectIdentity('baseline-cloud-client')).toBe('baseline-cloud-client')
    expect(resolveProjectIdentity('***')).toBe('default')
  })

  it('prefers the nearest repo-local config over Git and folder identity', async () => {
    const { resolveProjectIdentity } = await import('../src/project-identity')
    const directory = await repo('https://github.com/org/from-git.git')
    const nested = path.join(directory, 'packages', 'app')
    await fs.ensureDir(nested)
    await fs.outputFile(path.join(directory, '.baseline', 'project.json'), '{\n  "slug": "from-root"\n}\n')
    expect(resolveProjectIdentity(nested)).toBe('from-root')

    await fs.outputFile(path.join(nested, '.baseline', 'project.json'), '{\n  "slug": "from-nearest"\n}\n')
    expect(resolveProjectIdentity(nested)).toBe('from-nearest')
    expect(resolveProjectIdentity('explicit name')).toBe('explicit-name')
  })

  it.each([
    ['{', 'Expected'],
    ['{"slug": 42}', 'slug.*field'],
    ['{"slug": "***"}', 'valid project slug'],
  ])('fails clearly for invalid project config (%s)', async (contents, message) => {
    const { resolveProjectIdentity } = await import('../src/project-identity')
    const directory = await repo('https://github.com/org/from-git.git')
    const configPath = path.join(directory, '.baseline', 'project.json')
    await fs.outputFile(configPath, contents)
    expect(() => resolveProjectIdentity(directory)).toThrow(new RegExp(message))
  })

  it('initializes, refuses overwrite, and force-overwrites project config', async () => {
    const { initProjectConfig, resolveProjectIdentity } = await import('../src/project-identity')
    const directory = await fs.mkdtemp(path.join(tmpRoot, 'init-'))
    const configPath = initProjectConfig('My Project', directory)
    expect(configPath).toBe(path.join(directory, '.baseline', 'project.json'))
    expect(await fs.readFile(configPath, 'utf8')).toBe('{\n  "slug": "my-project"\n}\n')
    expect(resolveProjectIdentity(directory)).toBe('my-project')
    expect(() => initProjectConfig('other', directory)).toThrow(/already exists.*--force/)
    initProjectConfig('other', directory, true)
    expect(resolveProjectIdentity(directory)).toBe('other')
    expect(() => initProjectConfig('***', directory, true)).toThrow(/Invalid project slug/)
  })

  it('uses the repository identity for skill and session telemetry', async () => {
    process.env.BASELINE_CLOUD_URL = 'https://x.test'
    process.env.BASELINE_CLOUD_TOKEN = 'token'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as any)
    const directory = await repo('git@github.com:org/integration-project.git')
    const { skillTrack } = await import('../src/commands/skill')
    const { sessionTrack } = await import('../src/commands/session')
    const telemetry = await import('../src/telemetry')
    telemetry._resetForTests()

    await skillTrack({ name: 'sdd-apply', project: directory })
    await sessionTrack({ project: directory, inputTokens: 1 })
    await telemetry.flush()

    const events = fetchSpy.mock.calls.flatMap((call) => JSON.parse((call[1] as any).body).events)
    expect(events.map((event: { project: string }) => event.project)).toEqual([
      'integration-project',
      'integration-project',
    ])
  })
})
