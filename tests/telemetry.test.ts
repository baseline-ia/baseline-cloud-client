import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs-extra'
import os from 'os'
import path from 'path'

let tmpHome: string

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-client-tel-'))
  delete process.env.BASELINE_CLOUD_URL
  delete process.env.BASELINE_CLOUD_TOKEN
  delete process.env.BASELINE_TELEMETRY
})

afterEach(async () => {
  await fs.remove(tmpHome).catch(() => {})
  vi.restoreAllMocks()
})

async function loadTelemetry() {
  const telemetry = await import('../src/telemetry')
  const auth = await import('../src/auth')
  telemetry._resetForTests()
  auth._resetConfigForTests()
  auth._setHomedirForTests(tmpHome)
  return { ...telemetry, ...auth }
}

describe('telemetry > parseEstimate', () => {
  it('parses bucket names', async () => {
    const { parseEstimate } = await loadTelemetry()
    expect(parseEstimate('small')).toEqual({ minutes: 30, bucket: 'small' })
    expect(parseEstimate('medium')).toEqual({ minutes: 120, bucket: 'medium' })
    expect(parseEstimate('large')).toEqual({ minutes: 480, bucket: 'large' })
    expect(parseEstimate('xlarge')).toEqual({ minutes: 1920, bucket: 'xlarge' })
  })

  it('parses hour durations', async () => {
    const { parseEstimate } = await loadTelemetry()
    expect(parseEstimate('4h')).toEqual({ minutes: 240 })
    expect(parseEstimate('4.5h')).toEqual({ minutes: 270 })
    expect(parseEstimate('0.5h')).toEqual({ minutes: 30 })
  })

  it('parses minute durations', async () => {
    const { parseEstimate } = await loadTelemetry()
    expect(parseEstimate('30m')).toEqual({ minutes: 30 })
    expect(parseEstimate('240m')).toEqual({ minutes: 240 })
  })

  it('parses a bare number as minutes', async () => {
    const { parseEstimate } = await loadTelemetry()
    expect(parseEstimate('240')).toEqual({ minutes: 240 })
    expect(parseEstimate('60')).toEqual({ minutes: 60 })
  })

  it('trims whitespace and lowercases', async () => {
    const { parseEstimate } = await loadTelemetry()
    expect(parseEstimate('  SMALL  ')).toEqual({ minutes: 30, bucket: 'small' })
  })

  it('throws on invalid input', async () => {
    const { parseEstimate } = await loadTelemetry()
    expect(() => parseEstimate('garbage')).toThrow(/Invalid estimate/)
    expect(() => parseEstimate('-5')).toThrow()
    expect(() => parseEstimate('')).toThrow()
  })
})

describe('telemetry > isEnabled', () => {
  it('returns false when no config exists', async () => {
    const { isEnabled, _resetForTests } = await loadTelemetry()
    _resetForTests()
    expect(isEnabled()).toBe(false)
  })

  it('returns true when env vars are set', async () => {
    process.env.BASELINE_CLOUD_URL = 'https://x.test'
    process.env.BASELINE_CLOUD_TOKEN = 't'
    const { isEnabled, _resetForTests } = await loadTelemetry()
    _resetForTests()
    expect(isEnabled()).toBe(true)
  })

  it('returns false when BASELINE_TELEMETRY=0', async () => {
    process.env.BASELINE_CLOUD_URL = 'https://x.test'
    process.env.BASELINE_CLOUD_TOKEN = 't'
    process.env.BASELINE_TELEMETRY = '0'
    const { isEnabled, _resetForTests } = await loadTelemetry()
    _resetForTests()
    expect(isEnabled()).toBe(false)
  })

  it('returns false when setEnabled(false) was called', async () => {
    process.env.BASELINE_CLOUD_URL = 'https://x.test'
    process.env.BASELINE_CLOUD_TOKEN = 't'
    const { isEnabled, setEnabled, _resetForTests } = await loadTelemetry()
    _resetForTests()
    setEnabled(false)
    expect(isEnabled()).toBe(false)
  })
})

describe('telemetry > track + flush', () => {
  it('queues events and flushes when the batch fills (20)', async () => {
    process.env.BASELINE_CLOUD_URL = 'https://x.test'
    process.env.BASELINE_CLOUD_TOKEN = 't'
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as any)

    const { track, flush, _resetForTests } = await loadTelemetry()
    _resetForTests()

    for (let i = 0; i < 20; i++) {
      track({ event_type: 'change.open', project: 'default', payload: { i } })
    }
    // After 20 events, flush is auto-triggered
    await flush()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as any).body)
    expect(body.events).toHaveLength(20)
  })

  it('sends to /api/v1/events/batch with the correct auth header', async () => {
    process.env.BASELINE_CLOUD_URL = 'https://x.test'
    process.env.BASELINE_CLOUD_TOKEN = 'mytoken'
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as any)

    const { track, flush, _resetForTests } = await loadTelemetry()
    _resetForTests()

    track({ event_type: 'change.open', project: 'p', payload: {} })
    await flush()

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://x.test/api/v1/events/batch',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer mytoken' }),
      })
    )
  })

  it('disables telemetry on 401', async () => {
    process.env.BASELINE_CLOUD_URL = 'https://x.test'
    process.env.BASELINE_CLOUD_TOKEN = 'bad'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthorized' }),
    } as any)

    const { track, flush, isEnabled, _resetForTests } = await loadTelemetry()
    _resetForTests()

    track({ event_type: 'change.open', project: 'p', payload: {} })
    await flush()

    expect(isEnabled()).toBe(false)
  })

  it('does NOT disable telemetry on a 500 (just drops the batch)', async () => {
    process.env.BASELINE_CLOUD_URL = 'https://x.test'
    process.env.BASELINE_CLOUD_TOKEN = 't'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'oops' }),
    } as any)

    const { track, flush, isEnabled, _resetForTests } = await loadTelemetry()
    _resetForTests()

    track({ event_type: 'change.open', project: 'p', payload: {} })
    await flush()

    expect(isEnabled()).toBe(true)
  })

  it('silently drops events on network error (no throw, no requeue)', async () => {
    process.env.BASELINE_CLOUD_URL = 'https://x.test'
    process.env.BASELINE_CLOUD_TOKEN = 't'
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

    const { track, flush, _resetForTests } = await loadTelemetry()
    _resetForTests()

    track({ event_type: 'change.open', project: 'p', payload: {} })
    await expect(flush()).resolves.toBeUndefined()
  })

  it('is a no-op when telemetry is disabled', async () => {
    const { track, flush, _resetForTests } = await loadTelemetry()
    _resetForTests()
    track({ event_type: 'change.open', project: 'p', payload: {} })
    await expect(flush()).resolves.toBeUndefined()
  })

  it('strips trailing slashes from the server URL before sending', async () => {
    process.env.BASELINE_CLOUD_URL = 'https://x.test///'
    process.env.BASELINE_CLOUD_TOKEN = 't'
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as any)

    const { track, flush, _resetForTests } = await loadTelemetry()
    _resetForTests()

    track({ event_type: 'change.open', project: 'p', payload: {} })
    await flush()

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://x.test/api/v1/events/batch')
  })
})

describe('telemetry > envContext', () => {
  it('returns os, arch, and nodeVersion (no PII)', async () => {
    const { envContext } = await loadTelemetry()
    const ctx = envContext()
    expect(ctx).toHaveProperty('os')
    expect(ctx).toHaveProperty('arch')
    expect(ctx).toHaveProperty('nodeVersion')
    expect(typeof ctx.os).toBe('string')
    expect(typeof ctx.arch).toBe('string')
    expect(typeof ctx.nodeVersion).toBe('string')
  })
})

describe('telemetry > detectTools', () => {
  it('returns an object with all known tools as keys', async () => {
    const { detectTools } = await loadTelemetry()
    const tools = detectTools()
    expect(Object.keys(tools).sort()).toEqual(
      ['antigravity', 'claude', 'codex', 'kiro', 'opencode'].sort()
    )
    for (const v of Object.values(tools)) {
      expect(typeof v).toBe('boolean')
    }
  })
})

describe('telemetry > setEnabled', () => {
  it('clears the queue when set to false', async () => {
    process.env.BASELINE_CLOUD_URL = 'https://x.test'
    process.env.BASELINE_CLOUD_TOKEN = 't'
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as any)

    const { track, setEnabled, flush, _resetForTests } = await loadTelemetry()
    _resetForTests()

    track({ event_type: 'change.open', project: 'p', payload: {} })
    setEnabled(false)
    await flush()

    // The queued event was dropped by setEnabled, so the batch
    // endpoint was never called.
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
