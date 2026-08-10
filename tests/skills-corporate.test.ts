import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { _resetConfigForTests, _setHomedirForTests, saveConfig } from '../src/auth'
import { corporateSkillsPaths, statusCorporateSkills, syncCorporateSkills, verifyCorporateSkills, warnCorporateSkillDrift } from '../src/commands/skills-corporate'

const content = '# Corporate Review\n'
const hash = createHash('sha256').update(content).digest('hex')

function lockEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    skill_id: 'review',
    version: '1.0.0',
    sha256: hash,
    installed_at: new Date().toISOString(),
    fail_closed: false,
    path: '~/.baseline/skills/review/1.0.0/SKILL.md',
    ...overrides,
  }
}

function writeLock(entry: Record<string, unknown> = lockEntry()): void {
  mkdirSync(corporateSkillsPaths.directory(), { recursive: true })
  writeFileSync(corporateSkillsPaths.lock(), JSON.stringify({
    version: 1,
    synced_at: new Date().toISOString(),
    skills: { review: entry },
  }))
}

describe('corporate skills', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'baseline-corporate-'))
    _setHomedirForTests(home)
    _resetConfigForTests()
    saveConfig({ server_url: 'https://cloud.test', token: 'secret' })
    process.env.BASELINE_TELEMETRY = '0'
  })

  afterEach(() => {
    _setHomedirForTests(null)
    _resetConfigForTests()
    delete process.env.BASELINE_TELEMETRY
    rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('accepts numeric versions and writes lock/manifest metadata and read-only integrations', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'baseline-project-'))
    mkdirSync(join(projectRoot, '.claude'), { recursive: true })
    mkdirSync(join(projectRoot, '.opencode'), { recursive: true })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ skills: [{ slug: 'review', skill_id: 'skill-review', version: 3, content, contentHash: hash, failClosed: false }] }),
    } as Response)

    await syncCorporateSkills({ project: 'example-project', directory: projectRoot })

    const canonical = join(corporateSkillsPaths.directory(), 'review', '3')
    expect(readFileSync(join(canonical, 'SKILL.md'), 'utf8')).toBe(content)
    expect(statSync(join(canonical, 'SKILL.md')).mode & 0o777).toBe(0o444)
    const lock = JSON.parse(readFileSync(corporateSkillsPaths.lock(), 'utf8')) as { skills: Record<string, Record<string, unknown>> }
    expect(lock.skills.review).toEqual(expect.objectContaining({
      skill_id: 'skill-review',
      version: 3,
      sha256: hash,
      fail_closed: false,
      installed_at: expect.any(String),
      path: '~/.baseline/skills/review/3/SKILL.md',
    }))
    expect(JSON.parse(readFileSync(join(canonical, 'manifest.json'), 'utf8'))).toEqual({
      skill_id: 'skill-review', version: 3, sha256: hash, fail_closed: false, synced_at: expect.any(String),
    })
    expect(readFileSync(join(projectRoot, '.claude', 'skills', 'review', 'SKILL.md'), 'utf8')).toBe(content)
    expect(statSync(join(projectRoot, '.claude', 'skills', 'review', 'SKILL.md')).mode & 0o777).toBe(0o444)

    const updatedContent = '# Corporate Review v4\n'
    const updatedHash = createHash('sha256').update(updatedContent).digest('hex')
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ skills: [{ slug: 'review', skill_id: 'skill-review', version: 4, content: updatedContent, contentHash: updatedHash, failClosed: false }] }),
    } as Response)
    await syncCorporateSkills({ project: 'example-project', directory: projectRoot })
    const copied = join(projectRoot, '.claude', 'skills', 'review', 'SKILL.md')
    expect(readFileSync(copied, 'utf8')).toBe(updatedContent)
    expect(statSync(copied).mode & 0o777).toBe(0o444)
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('does not write a lock when a remote hash is invalid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ skills: [{ slug: 'review', version: '1.0.0', content, sha256: 'bad' }] }),
    } as Response)

    await expect(syncCorporateSkills({ project: 'example-project' })).rejects.toThrow('failed hash verification')
    expect(existsSync(corporateSkillsPaths.lock())).toBe(false)
  })

  it('reports available versions in status', async () => {
    writeLock()
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ skills: [{ slug: 'review', version: '2.0.0', content, sha256: hash }] }) } as Response)

    await statusCorporateSkills({ project: 'example-project' })

    expect(info.mock.calls.some((call) => String(call[1]).includes('update available'))).toBe(true)
  })

  it('passes cached verification offline and fails closed when online verification is unreachable', async () => {
    const canonical = join(corporateSkillsPaths.directory(), 'review', '1.0.0')
    mkdirSync(canonical, { recursive: true })
    writeFileSync(join(canonical, 'SKILL.md'), content)
    writeFileSync(join(canonical, 'manifest.json'), JSON.stringify({ skill_id: 'review', version: '1.0.0', sha256: hash, fail_closed: false, synced_at: new Date().toISOString() }))
    writeLock()
    expect(await verifyCorporateSkills()).toBe(true)

    writeFileSync(join(canonical, 'manifest.json'), JSON.stringify({ skill_id: 'review', version: '1.0.0', sha256: hash, fail_closed: true, synced_at: new Date().toISOString() }))
    writeLock(lockEntry({ fail_closed: true }))
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    expect(await verifyCorporateSkills()).toBe(false)
  })

  it('sends the project query for online verification and accepts the server response', async () => {
    const canonical = join(corporateSkillsPaths.directory(), 'review', '1.0.0')
    mkdirSync(canonical, { recursive: true })
    writeFileSync(join(canonical, 'SKILL.md'), content)
    writeFileSync(join(canonical, 'manifest.json'), JSON.stringify({ skill_id: 'review', version: '1.0.0', sha256: hash, fail_closed: true, synced_at: new Date().toISOString() }))
    writeLock(lockEntry({ fail_closed: true }))
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, active: true, version: 1, contentHash: hash }),
    } as Response)

    expect(await verifyCorporateSkills({ project: 'example-project' })).toBe(true)
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://cloud.test/api/v1/skills/review/verify?project=example-project')
  })

  it('detects tampered canonical content and warns for exact integration roots', async () => {
    const canonical = join(corporateSkillsPaths.directory(), 'review', '1.0.0')
    mkdirSync(canonical, { recursive: true })
    writeFileSync(join(canonical, 'SKILL.md'), 'tampered\n')
    writeFileSync(join(canonical, 'manifest.json'), JSON.stringify({ skill_id: 'review', version: '1.0.0', sha256: hash, fail_closed: false, synced_at: new Date().toISOString() }))
    writeLock()
    const projectRoot = mkdtempSync(join(tmpdir(), 'baseline-project-'))
    mkdirSync(join(projectRoot, '.claude', 'skills', 'review'), { recursive: true })
    mkdirSync(join(projectRoot, '.opencode', 'skills', 'review'), { recursive: true })
    writeFileSync(join(projectRoot, '.claude', 'skills', 'review', 'SKILL.md'), content)
    writeFileSync(join(projectRoot, '.opencode', 'skills', 'review', 'SKILL.md'), content)
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    expect(await verifyCorporateSkills()).toBe(false)
    warnCorporateSkillDrift(projectRoot)

    expect(output.mock.calls.filter((call) => String(call[1]).includes('already exists')).length).toBe(2)
    rmSync(projectRoot, { recursive: true, force: true })
  })
})
