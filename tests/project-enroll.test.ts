import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { _resetConfigForTests, _setHomedirForTests } from '../src/auth'

describe('project enroll', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.BASELINE_CLOUD_URL = 'https://cloud.test'
    process.env.BASELINE_CLOUD_TOKEN = 'prefix.secret'
  })

  it('enrolls the resolved project with bearer and idempotency headers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, created: true, project: { slug: 'my-project' } }),
    } as any)
    const { enrollProject } = await import('../src/commands/project')

    await enrollProject({ slug: 'My Project', name: 'My Project' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://cloud.test/api/v1/projects/enroll',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer prefix.secret',
          'Idempotency-Key': 'project-enroll:my-project',
        }),
        body: JSON.stringify({ slug: 'my-project', name: 'My Project' }),
      }),
    )
  })

  it('rejects conflict responses without claiming success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error_code: 'project_already_enrolled' }),
    } as any)
    const { enrollProject } = await import('../src/commands/project')

    await expect(enrollProject({ slug: 'my-project' })).rejects.toThrow('project_already_enrolled')
  })

  it('syncs assigned corporate skills after successful enrollment', async () => {
    const home = mkdtempSync(join(tmpdir(), 'baseline-enroll-'))
    _setHomedirForTests(home)
    _resetConfigForTests()
    process.env.BASELINE_TELEMETRY = '0'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ created: true, assigned_skills: ['review'] }) } as any)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ skills: [] }) } as any)
    const { enrollProject } = await import('../src/commands/project')

    await enrollProject({ slug: 'my-project' })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('https://cloud.test/api/v1/skills?project=my-project')
    rmSync(home, { recursive: true, force: true })
    delete process.env.BASELINE_TELEMETRY
    _setHomedirForTests(null)
    _resetConfigForTests()
  })
})
