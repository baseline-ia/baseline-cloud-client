import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs-extra'
import os from 'os'
import path from 'path'

let tmpHome: string

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-client-hooks-'))
  process.env.BASELINE_CLOUD_URL = 'https://x.test'
  process.env.BASELINE_CLOUD_TOKEN = 't'
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
  } as any)
})

afterEach(async () => {
  await fs.remove(tmpHome).catch(() => {})
  delete process.env.BASELINE_CLOUD_URL
  delete process.env.BASELINE_CLOUD_TOKEN
  vi.restoreAllMocks()
})

async function loadGitHooks() {
  const gh = await import('../src/git-hooks')
  const auth = await import('../src/auth')
  auth._resetConfigForTests()
  auth._setHomedirForTests(tmpHome)
  // Default: real execSync (restored by afterEach)
  gh._setExecSyncForTests(null)
  return gh
}

/** Test helper: make all `git` invocations throw. */
function makeNotAGitRepo() {
  return (cmd: string) => {
    throw new Error(`not a git repo (cmd=${cmd})`)
  }
}

describe('git-hooks > installHook + isHookInstalled', () => {
  it('installs the hook in the current git repo and detects it', async () => {
    // Set up a fake git repo in a sub-dir
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-client-repo-'))
    const gitDir = path.join(repoDir, '.git')
    await fs.ensureDir(path.join(gitDir, 'hooks'))
    // chdir into the repo
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(repoDir)
    // isInsideGitRepo uses `git rev-parse --is-inside-work-tree`. We
    // don't have a real git repo, so we mock execSync to return
    // "true" for the is-inside check and the git-dir check.
    const gh = await loadGitHooks()
    gh._setExecSyncForTests((cmd: string) => {
      if (cmd.includes('--is-inside-work-tree')) return Buffer.from('true')
      if (cmd.includes('rev-parse --git-dir')) return Buffer.from(gitDir)
      return Buffer.from('')
    })

    try {
      const r = gh.installHook()
      expect(r.installed).toBe(true)
      expect(r.message).toContain('Installed post-commit hook')

      // The hook file exists
      const hookPath = path.join(gitDir, 'hooks', 'post-commit')
      expect(await fs.pathExists(hookPath)).toBe(true)
      // It's executable (mode 0755)
      const stat = await fs.stat(hookPath)
      if (process.platform !== 'win32') {
        expect(stat.mode & 0o777).toBe(0o755)
      }
      // It contains the marker
      const content = await fs.readFile(hookPath, 'utf8')
      expect(content).toContain('# baseline-cli post-commit hook')
      // isHookInstalled detects it
      expect(gh.isHookInstalled()).toBe(true)
    } finally {
      cwdSpy.mockRestore()
      await fs.remove(repoDir).catch(() => {})
    }
  })

  it('returns installed=false when not in a git repo', async () => {
    const gh = await loadGitHooks()
    gh._setExecSyncForTests(makeNotAGitRepo())
    const r = gh.installHook()
    expect(r.installed).toBe(false)
    expect(r.message).toMatch(/Not inside a git repository/)
  })
})

describe('git-hooks > uninstallHook', () => {
  it('removes a baseline-managed hook', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-client-rm-repo-'))
    const gitDir = path.join(repoDir, '.git')
    await fs.ensureDir(path.join(gitDir, 'hooks'))
    vi.spyOn(process, 'cwd').mockReturnValue(repoDir)
    const gh = await loadGitHooks()
    gh._setExecSyncForTests((cmd: string) => {
      if (cmd.includes('rev-parse --git-dir')) return Buffer.from(gitDir)
      return Buffer.from('')
    })

    try {
      gh.installHook()
      expect(gh.isHookInstalled()).toBe(true)

      const r = gh.uninstallHook()
      expect(r.uninstalled).toBe(true)
      expect(r.message).toMatch(/Removed baseline post-commit hook/)
      expect(gh.isHookInstalled()).toBe(false)
    } finally {
      await fs.remove(repoDir).catch(() => {})
    }
  })

  it('refuses to remove a non-baseline hook', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-client-foreign-'))
    const gitDir = path.join(repoDir, '.git')
    await fs.ensureDir(path.join(gitDir, 'hooks'))
    await fs.writeFile(
      path.join(gitDir, 'hooks', 'post-commit'),
      '#!/bin/sh\necho "some other tool\'s hook"\n'
    )
    vi.spyOn(process, 'cwd').mockReturnValue(repoDir)
    const gh = await loadGitHooks()
    gh._setExecSyncForTests((cmd: string) => {
      if (cmd.includes('rev-parse --git-dir')) return Buffer.from(gitDir)
      return Buffer.from('')
    })

    try {
      const r = gh.uninstallHook()
      expect(r.uninstalled).toBe(false)
      expect(r.message).toMatch(/not managed by baseline/)
      // The foreign hook is still there
      expect(await fs.pathExists(path.join(gitDir, 'hooks', 'post-commit'))).toBe(true)
    } finally {
      await fs.remove(repoDir).catch(() => {})
    }
  })
})

describe('git-hooks > fireCommitEvent', () => {
  it('tracks a change.commit event with the right payload', async () => {
    const fetchSpy = vi.mocked(globalThis.fetch)
    fetchSpy.mockClear()
    const gh = await loadGitHooks()
    const telemetry = await import('../src/telemetry')
    telemetry._resetForTests()
    gh.fireCommitEvent({
      changeName: 'add-vitest',
      sha: 'abc123',
      shortSha: 'abc',
      message: 'feat: add vitest',
      filesChanged: 5,
      linesAdded: 100,
      linesRemoved: 20,
      authorEmail: 'dev@example.com',
    })
    // Force a flush (the auto-flush timer is 5s; we don't want to wait).
    await telemetry.flush()
    expect(fetchSpy).toHaveBeenCalled()
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as any).body)
    expect(body.events[0].event_type).toBe('change.commit')
    expect(body.events[0].payload.changeName).toBe('add-vitest')
    expect(body.events[0].payload.sha).toBe('abc123')
  })
})

describe('git-hooks > hookStatus', () => {
  it('returns installed=false with a null path when not in a repo', async () => {
    const gh = await loadGitHooks()
    gh._setExecSyncForTests(makeNotAGitRepo())
    const s = gh.hookStatus()
    expect(s.installed).toBe(false)
    expect(s.path).toBeNull()
  })
})
