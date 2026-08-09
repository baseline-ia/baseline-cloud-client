import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs-extra'
import os from 'os'
import path from 'path'

let tmpHome: string

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-client-sdd-home-'))
  process.env.BASELINE_CLOUD_URL = 'https://x.test'
  process.env.BASELINE_CLOUD_TOKEN = 'test-token'
  delete process.env.BASELINE_TELEMETRY
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as any)
  const telemetry = await import('../src/telemetry')
  const auth = await import('../src/auth')
  telemetry._resetForTests()
  auth._resetConfigForTests()
  auth._setHomedirForTests(tmpHome)
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env.BASELINE_CLOUD_URL
  delete process.env.BASELINE_CLOUD_TOKEN
  const auth = await import('../src/auth')
  auth._resetConfigForTests()
  auth._setHomedirForTests(null)
  await fs.remove(tmpHome)
})

async function loadPhaseCommands() {
  return await import('../src/commands/sdd-phase')
}

function statePath(): string {
  return path.join(tmpHome, '.baseline', 'sdd-phase-state.json')
}

describe('sdd phase timing', () => {
  it('persists a start and emits stable project identifiers', async () => {
    const { sddPhaseStart } = await loadPhaseCommands()
    vi.setSystemTime(new Date('2026-01-01T10:00:00.000Z'))

    await sddPhaseStart({ phase: 'design', change: 'add-feature', project: '/tmp/example-project' })

    const state = JSON.parse(await fs.readFile(statePath(), 'utf8'))
    expect(Object.values(state.phases)[0]).toEqual({
      phase: 'design',
      change: 'add-feature',
      project: '/tmp/example-project',
      startedAt: '2026-01-01T10:00:00.000Z',
    })
    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as any).body)
    expect(body.events[0]).toMatchObject({
      event_type: 'sdd.phase.started',
      project: '/tmp/example-project',
      occurred_at: '2026-01-01T10:00:00.000Z',
      payload: { phase: 'design', change: 'add-feature', project: '/tmp/example-project', startedAt: '2026-01-01T10:00:00.000Z' },
    })
  })

  it('calculates duration, emits completion, and cleans up after queueing', async () => {
    const { sddPhaseStart, sddPhaseComplete } = await loadPhaseCommands()
    vi.setSystemTime(new Date('2026-01-01T10:00:00.000Z'))
    await sddPhaseStart({ phase: 'apply', change: 'change-a', project: 'project-a' })
    vi.setSystemTime(new Date('2026-01-01T10:02:03.500Z'))

    await sddPhaseComplete({ phase: 'apply', change: 'change-a', project: 'project-a' })

    expect(await fs.pathExists(statePath())).toBe(false)
    const calls = vi.mocked(globalThis.fetch).mock.calls
    const body = JSON.parse((calls[calls.length - 1]?.[1] as any).body)
    expect(body.events[0]).toMatchObject({
      event_type: 'sdd.phase.completed',
      project: 'project-a',
      payload: {
        phase: 'apply',
        change: 'change-a',
        project: 'project-a',
        startedAt: '2026-01-01T10:00:00.000Z',
        completedAt: '2026-01-01T10:02:03.500Z',
        durationSeconds: 123.5,
      },
    })
  })

  it('rejects duplicate starts and missing completion state', async () => {
    const { sddPhaseStart, sddPhaseComplete } = await loadPhaseCommands()
    await sddPhaseStart({ phase: 'spec', change: 'change-a' })
    await expect(sddPhaseStart({ phase: 'spec', change: 'change-a' })).rejects.toThrow(/already started/)
    await expect(sddPhaseComplete({ phase: 'verify', change: 'change-a' })).rejects.toThrow(/No started SDD phase/)
  })

  it('retains completion state when telemetry cannot queue the event', async () => {
    const { sddPhaseStart, sddPhaseComplete } = await loadPhaseCommands()
    await sddPhaseStart({ phase: 'verify', change: 'change-a' })
    process.env.BASELINE_TELEMETRY = '0'

    await sddPhaseComplete({ phase: 'verify', change: 'change-a' })

    expect(await fs.pathExists(statePath())).toBe(true)
    const state = JSON.parse(await fs.readFile(statePath(), 'utf8'))
    expect(Object.values(state.events)).toHaveLength(1)
  })

  it('propagates child success and records a completed status', async () => {
    const { sddPhaseRun } = await loadPhaseCommands()
    const code = await sddPhaseRun({ phase: 'apply', change: 'success', command: process.execPath, args: ['-e', ''] })
    expect(code).toBe(0)
    const calls = vi.mocked(globalThis.fetch).mock.calls
    const body = JSON.parse((calls[calls.length - 1]?.[1] as any).body)
    expect(body.events[0].payload.status).toBe('completed')
  })

  it('propagates child failure and records a failed completion', async () => {
    const { sddPhaseRun } = await loadPhaseCommands()
    const code = await sddPhaseRun({ phase: 'apply', change: 'failure', command: process.execPath, args: ['-e', 'process.exit(7)'] })
    expect(code).toBe(7)
    const calls = vi.mocked(globalThis.fetch).mock.calls
    const body = JSON.parse((calls[calls.length - 1]?.[1] as any).body)
    expect(body.events[0].payload.status).toBe('failed')
  })

  it('replays pending events and is idempotent', async () => {
    const { sddPhaseStart, syncSddPhaseEvents } = await loadPhaseCommands()
    process.env.BASELINE_TELEMETRY = '0'
    await sddPhaseStart({ phase: 'design', change: 'replay', project: 'p' })
    expect(await syncSddPhaseEvents()).toBe(0)

    delete process.env.BASELINE_TELEMETRY
    const auth = await import('../src/auth')
    auth._resetConfigForTests()
    expect(await syncSddPhaseEvents()).toBe(1)
    expect(await syncSddPhaseEvents()).toBe(0)
    expect(JSON.parse(await fs.readFile(statePath(), 'utf8')).events).toEqual({})
  })
})
