import { beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('enrolls successfully even when the server returns assigned_skills', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ created: true, assigned_skills: ['review'] }) } as any)
    const { enrollProject } = await import('../src/commands/project')

    await enrollProject({ slug: 'my-project' })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://cloud.test/api/v1/projects/enroll')
  })
})
