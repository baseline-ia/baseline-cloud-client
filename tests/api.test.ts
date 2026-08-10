import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { postJson, getJson } from '../src/api'

describe('api > postJson', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('POSTs the body as JSON and parses the response', async () => {
    const mockRes = {
      ok: true,
      status: 201,
      json: vi.fn().mockResolvedValue({ id: 'abc' }),
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockRes as any)

    const result = await postJson('https://x.test/v1/auth/signup', { username: 'a', password: 'b' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://x.test/v1/auth/signup',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ username: 'a', password: 'b' }),
      })
    )
    expect(result).toEqual({ status: 201, json: { id: 'abc' }, ok: true })
  })

  it('passes through custom headers (e.g. Authorization)', async () => {
    const mockRes = { ok: true, status: 200, json: vi.fn().mockResolvedValue({}) }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockRes as any)

    await postJson('https://x.test/v1/foo', { a: 1 }, { Authorization: 'Bearer t' })

    const callArgs = (fetchSpy => fetchSpy.mock.calls[0])(vi.mocked(globalThis.fetch))
    const headers = (callArgs[1] as any).headers
    expect(headers['Authorization']).toBe('Bearer t')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('returns ok=false and the parsed body on non-2xx', async () => {
    const mockRes = {
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({ error: 'bad creds' }),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockRes as any)

    const result = await postJson<{ error: string }>('https://x.test/v1/auth/login', {})
    expect(result).toEqual({ status: 401, json: { error: 'bad creds' }, ok: false })
  })

  it('returns json=null when the response has no JSON body', async () => {
    const mockRes = {
      ok: true,
      status: 204,
      json: vi.fn().mockRejectedValue(new Error('no body')),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockRes as any)

    const result = await postJson('https://x.test/v1/foo', {})
    expect(result.status).toBe(204)
    expect(result.json).toBeNull()
  })

  it('rejects on network error (does not swallow)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(postJson('https://x.test/v1/foo', {})).rejects.toThrow('ECONNREFUSED')
  })
})

describe('api > getJson', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('GETs the URL and parses the response', async () => {
    const mockRes = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ items: [1, 2, 3] }),
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockRes as any)

    const result = await getJson<{ items: number[] }>('https://x.test/v1/items')

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://x.test/v1/items',
      expect.objectContaining({ method: 'GET' })
    )
    expect(result.json).toEqual({ items: [1, 2, 3] })
  })

  it('rejects on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'))
    await expect(getJson('https://x.test/v1/items')).rejects.toThrow('timeout')
  })

  it('passes an abort signal when a timeout is requested', async () => {
    const mockRes = { ok: true, status: 200, json: vi.fn().mockResolvedValue({}) }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockRes as any)

    await getJson('https://x.test/v1/items', {}, { timeoutMs: 5000 })

    expect(fetchSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })
})
