import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs-extra'
import os from 'os'
import path from 'path'

let tmpHome: string

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-client-auth-'))
  delete process.env.BASELINE_CLOUD_URL
  delete process.env.BASELINE_CLOUD_TOKEN
})

afterEach(async () => {
  await fs.remove(tmpHome).catch(() => {})
})

async function loadAuth() {
  const auth = await import('../src/auth')
  auth._resetConfigForTests()
  auth._setHomedirForTests(tmpHome)
  return auth
}

describe('auth > loadConfig', () => {
  it('returns null when no env vars and no config file', async () => {
    const { loadConfig, _resetConfigForTests } = await loadAuth()
    _resetConfigForTests()
    expect(loadConfig()).toBeNull()
  })

  it('reads from env vars when both BASELINE_CLOUD_URL and BASELINE_CLOUD_TOKEN are set', async () => {
    process.env.BASELINE_CLOUD_URL = 'https://cloud.example.com'
    process.env.BASELINE_CLOUD_TOKEN = 'abc.def.ghi'
    const { loadConfig, _resetConfigForTests } = await loadAuth()
    _resetConfigForTests()
    const cfg = loadConfig()
    expect(cfg).toEqual({ server_url: 'https://cloud.example.com', token: 'abc.def.ghi' })
  })

  it('strips trailing slashes from the URL', async () => {
    process.env.BASELINE_CLOUD_URL = 'https://cloud.example.com///'
    process.env.BASELINE_CLOUD_TOKEN = 'abc'
    const { loadConfig, _resetConfigForTests } = await loadAuth()
    _resetConfigForTests()
    expect(loadConfig()?.server_url).toBe('https://cloud.example.com')
  })

  it('falls through to the file when env vars are incomplete', async () => {
    process.env.BASELINE_CLOUD_URL = 'https://cloud.example.com'
    // token missing
    const { loadConfig, saveConfig, _resetConfigForTests } = await loadAuth()
    _resetConfigForTests()
    saveConfig({ server_url: 'https://from-file.com', token: 'file-token' })
    expect(loadConfig()?.token).toBe('file-token')
  })

  it('reads from ~/.baseline/cloud.json when env vars are absent', async () => {
    const { saveConfig, loadConfig, _resetConfigForTests } = await loadAuth()
    _resetConfigForTests()
    saveConfig({ server_url: 'https://from-file.com', token: 'file-token' })
    expect(loadConfig()).toEqual({
      server_url: 'https://from-file.com',
      token: 'file-token',
    })
  })

  it('returns null when the config file is corrupted', async () => {
    const filePath = path.join(tmpHome, '.baseline', 'cloud.json')
    await fs.ensureDir(path.dirname(filePath))
    await fs.writeFile(filePath, '{ not valid json', { mode: 0o600 })
    const { loadConfig } = await loadAuth()
    expect(loadConfig()).toBeNull()
  })

  it('memoizes the result so subsequent calls do not re-read disk', async () => {
    const { saveConfig, loadConfig, _resetConfigForTests } = await loadAuth()
    _resetConfigForTests()
    saveConfig({ server_url: 'https://memo.com', token: 'm' })
    const first = loadConfig()
    // Delete the file behind the scenes
    await fs.remove(path.join(tmpHome, '.baseline', 'cloud.json'))
    const second = loadConfig()
    expect(first).toBe(second) // same object reference
  })
})

describe('auth > saveConfig', () => {
  it('writes the file with mode 0600 on Unix', async () => {
    if (process.platform === 'win32') return // skip on Windows
    const { saveConfig } = await loadAuth()
    saveConfig({ server_url: 'https://x.com', token: 't' })
    const stat = await fs.stat(path.join(tmpHome, '.baseline', 'cloud.json'))
    // Mode 0600 = owner read/write only. The lower 9 bits should be 0o600.
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('creates ~/.baseline if it does not exist', async () => {
    const { saveConfig } = await loadAuth()
    saveConfig({ server_url: 'https://x.com', token: 't' })
    expect(await fs.pathExists(path.join(tmpHome, '.baseline'))).toBe(true)
  })

  it('overwrites an existing config', async () => {
    const { saveConfig, loadConfig, _resetConfigForTests } = await loadAuth()
    _resetConfigForTests()
    saveConfig({ server_url: 'https://first.com', token: 'a' })
    saveConfig({ server_url: 'https://second.com', token: 'b' })
    expect(loadConfig()).toEqual({ server_url: 'https://second.com', token: 'b' })
  })
})

describe('auth > clearConfig', () => {
  it('removes the file and the in-memory cache', async () => {
    const { saveConfig, clearConfig, loadConfig, _resetConfigForTests } = await loadAuth()
    _resetConfigForTests()
    saveConfig({ server_url: 'https://x.com', token: 't' })
    clearConfig()
    expect(await fs.pathExists(path.join(tmpHome, '.baseline', 'cloud.json'))).toBe(false)
    expect(loadConfig()).toBeNull()
  })

  it('is idempotent (succeeds even if the file does not exist)', async () => {
    const { clearConfig } = await loadAuth()
    expect(() => clearConfig()).not.toThrow()
  })
})

describe('auth > tokenPrefix', () => {
  it('returns the first 3 chars followed by .***', async () => {
    const { tokenPrefix } = await loadAuth()
    expect(tokenPrefix('abcdefghij')).toBe('abc.***')
  })

  it('handles tokens without dots', async () => {
    const { tokenPrefix } = await loadAuth()
    expect(tokenPrefix('abcdefghij')).toBe('abc.***')
  })

  it('handles short tokens', async () => {
    const { tokenPrefix } = await loadAuth()
    expect(tokenPrefix('ab')).toBe('ab.***')
  })
})

describe('auth > getCloudConfigPath', () => {
  it('returns ~/.baseline/cloud.json', async () => {
    const { getCloudConfigPath } = await loadAuth()
    expect(getCloudConfigPath()).toBe(path.join(tmpHome, '.baseline', 'cloud.json'))
  })
})
