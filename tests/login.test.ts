import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'fs-extra'
import os from 'os'
import path from 'path'

const exitError = new Error('process exit')

vi.mock('node:process', async () => {
  const actual = await vi.importActual<typeof import('node:process')>('node:process')
  return { ...actual, exit: vi.fn(() => { throw exitError }) }
})

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(),
}))

describe('login token issuance', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-client-login-'))
    process.env.BASELINE_TELEMETRY = '0'
    vi.restoreAllMocks()
  })

  afterEach(async () => {
    const { _setHomedirForTests } = await import('../src/auth')
    _setHomedirForTests(null)
    delete process.env.BASELINE_TELEMETRY
    await fs.remove(tmpHome)
    vi.restoreAllMocks()
  })

  it('issues and saves a bearer token after successful username/password login', async () => {
    const { _setHomedirForTests, _resetConfigForTests, loadConfig } = await import('../src/auth')
    _setHomedirForTests(tmpHome)
    _resetConfigForTests()

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: { id: '1', username: 'alice', email: 'a@test', role: 'member' } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ token: { id: 't1', raw: 'raw-token', prefix: 'raw', name: 'alice' } }),
      } as Response)

    const { login } = await import('../src/commands/login')
    await login({
      noInput: true,
      serverUrl: 'https://cloud.test',
      username: 'alice',
      password: 'secret',
      skipHookPrompt: true,
    })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('https://cloud.test/api/v1/auth/token')
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1] && (fetchSpy.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      name: 'alice',
      password: 'secret',
    })
    expect(loadConfig()).toEqual({ server_url: 'https://cloud.test', token: 'raw-token' })
  })

  it('falls back without saving a token when issuance fails', async () => {
    const { _setHomedirForTests, _resetConfigForTests, loadConfig, getCloudConfigPath } = await import('../src/auth')
    _setHomedirForTests(tmpHome)
    _resetConfigForTests()

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: { id: '1', username: 'alice', email: 'a@test', role: 'member' } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ token_issue: 'Ask an administrator to issue a token.' }),
      } as Response)

    const warn = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { login } = await import('../src/commands/login')

    await expect(login({
      noInput: true,
      serverUrl: 'https://cloud.test',
      username: 'alice',
      password: 'secret',
      skipHookPrompt: true,
    })).rejects.toBe(exitError)

    expect(loadConfig()).toBeNull()
    expect(await fs.pathExists(getCloudConfigPath())).toBe(false)
    expect(warn.mock.calls.flat().join(' ')).toContain('Ask an administrator to issue a token.')
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret')
  })

  it('prompts for and securely saves an existing API token', async () => {
    const { _setHomedirForTests, _resetConfigForTests, loadConfig, getCloudConfigPath } = await import('../src/auth')
    const { createInterface } = await import('node:readline/promises')
    _setHomedirForTests(tmpHome)
    _resetConfigForTests()

    const question = vi.fn()
      .mockResolvedValueOnce('b')
      .mockResolvedValueOnce('https://cloud.test///')
      .mockResolvedValueOnce('raw-api-token')
    vi.mocked(createInterface).mockReturnValue({ question, close: vi.fn() } as any)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const { login } = await import('../src/commands/login')
    await login({ skipHookPrompt: true })

    expect(loadConfig()).toEqual({ server_url: 'https://cloud.test', token: 'raw-api-token' })
    const stat = await fs.stat(getCloudConfigPath())
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600)
    expect(question).toHaveBeenCalledTimes(3)
    expect(log.mock.calls.flat().join(' ')).not.toContain('raw-api-token')
  })
})

describe('readSecret', () => {
  it('masks TTY input and restores cooked mode on Enter', async () => {
    const { readSecret } = await import('../src/commands/login')
    const input = new EventEmitter() as EventEmitter & {
      isTTY: boolean
      isRaw: boolean
      setRawMode: (mode: boolean) => typeof input
      resume: () => typeof input
    }
    input.isTTY = true
    input.isRaw = false
    const rawModes: boolean[] = []
    input.setRawMode = (mode) => {
      rawModes.push(mode)
      input.isRaw = mode
      return input
    }
    input.resume = () => input
    const writes: string[] = []
    const output = { isTTY: true, write: (chunk: string) => (writes.push(chunk), true) }
    const rl = { question: vi.fn() }

    const result = readSecret('Password: ', rl as any, input, output)
    input.emit('data', 'secret')
    input.emit('data', '\n')

    await expect(result).resolves.toBe('secret')
    expect(rawModes).toEqual([true, false])
    expect(writes).toEqual(['Password: ', '\n'])
    expect(rl.question).not.toHaveBeenCalled()
  })

  it('restores cooked mode when TTY input is cancelled', async () => {
    const { readSecret } = await import('../src/commands/login')
    const input = new EventEmitter() as EventEmitter & {
      isTTY: boolean
      isRaw: boolean
      setRawMode: (mode: boolean) => typeof input
      resume: () => typeof input
    }
    input.isTTY = true
    input.isRaw = false
    const rawModes: boolean[] = []
    input.setRawMode = (mode) => (rawModes.push(mode), input)
    input.resume = () => input
    const output = { isTTY: true, write: vi.fn(() => true) }

    const result = readSecret('Token: ', { question: vi.fn() } as any, input, output)
    input.emit('data', '\u0003')

    await expect(result).rejects.toThrow('Input cancelled')
    expect(rawModes).toEqual([true, false])
    expect(output.write).toHaveBeenCalledWith('\n')
  })
})
