import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Command } from 'commander'
import {
  buildCloudCommand,
  buildOpenspecCommand,
  buildHooksCommand,
  register,
  type PluginContext,
  type TelemetryEventLike,
} from '../src/index'

// In-process tests for the addon's public surface.
//
// We don't load the addon via `await import('@amsintegra/baseline-cloud-client')`
// (the loader's path); instead, we import the source directly and
// exercise the register() function with a fake plugin context. This
// is the same code path the loader runs, just without the dynamic
// import indirection.

let capturedTelemetryHandlers: Array<(event: TelemetryEventLike) => void | Promise<void>> = []

function makePluginContext(): PluginContext & {
  registeredCommands: Command[]
  configStore: Record<string, unknown>
} {
  capturedTelemetryHandlers = []
  const registeredCommands: Command[] = []
  const configStore: Record<string, unknown> = {}

  return {
    name: 'cloud',
    version: '0.0.0',
    configDir: '/tmp/fake-config',
    registerCommand: (cmd) => {
      registeredCommands.push(cmd)
    },
    onTelemetry: (handler) => {
      capturedTelemetryHandlers.push(handler)
    },
    getConfig: async <T>(key: string) => (key in configStore ? (configStore[key] as T) : null),
    setConfig: async <T>(key: string, value: T) => {
      configStore[key] = value
    },
    registeredCommands,
    configStore,
  }
}

describe('addon > buildCloudCommand', () => {
  it('builds a Command named "cloud" with login, logout, status, flush subcommands', () => {
    const cmd = buildCloudCommand()
    expect(cmd.name()).toBe('cloud')
    const subNames = cmd.commands.map((c) => c.name())
    expect(subNames.sort()).toEqual(['flush', 'login', 'logout', 'status'])
  })

  it('login subcommand has the expected options', () => {
    const cmd = buildCloudCommand()
    const login = cmd.commands.find((c) => c.name() === 'login')!
    // commander stores options on the Command
    const optionFlags = login.options.map((o) => o.long ?? o.short).filter(Boolean)
    expect(optionFlags).toContain('--server')
    expect(optionFlags).toContain('--username')
    expect(optionFlags).toContain('--password')
  })
})

describe('addon > buildOpenspecCommand', () => {
  it('builds a Command named "openspec" with new, list, close, sync subcommands', () => {
    const cmd = buildOpenspecCommand()
    expect(cmd.name()).toBe('openspec')
    const subNames = cmd.commands.map((c) => c.name())
    expect(subNames.sort()).toEqual(['close', 'list', 'new', 'sync'])
  })
})

describe('addon > buildHooksCommand', () => {
  it('builds a Command named "hooks" with install, uninstall, status, fire-commit subcommands', () => {
    const cmd = buildHooksCommand()
    expect(cmd.name()).toBe('hooks')
    const subNames = cmd.commands.map((c) => c.name())
    expect(subNames.sort()).toEqual(['fire-commit', 'install', 'status', 'uninstall'])
  })
})

describe('addon > register', () => {
  beforeEach(() => {
    capturedTelemetryHandlers = []
  })

  it('returns a manifest with name and version', async () => {
    const ctx = makePluginContext()
    const manifest = await register(ctx)
    expect(manifest.name).toBe('baseline-cloud-client')
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('registers exactly six subcommands: cloud, openspec, hooks, skill, session, kiro', async () => {
    const ctx = makePluginContext()
    await register(ctx)
    const names = ctx.registeredCommands.map((c) => c.name()).sort()
    expect(names).toEqual(['cloud', 'hooks', 'kiro', 'openspec', 'session', 'skill'])
  })

  it('registers at least one telemetry handler', async () => {
    const ctx = makePluginContext()
    await register(ctx)
    expect(capturedTelemetryHandlers.length).toBeGreaterThanOrEqual(1)
  })

  it('the telemetry handler forwards events via the addons track function', async () => {
    const ctx = makePluginContext()
    await register(ctx)
    const handler = capturedTelemetryHandlers[0]!

    // Spy on the addon's track by mocking the global fetch that
    // track() uses to flush.
    process.env.BASELINE_CLOUD_URL = 'https://x.test'
    process.env.BASELINE_CLOUD_TOKEN = 't'
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as any)

    await handler({ event_type: 'cli.install', project: 'p', payload: { foo: 'bar' } })
    // Force a flush so the queue is sent
    const { flush } = await import('../src/telemetry')
    await flush()

    expect(fetchSpy).toHaveBeenCalled()
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as any).body)
    expect(body.events[0].event_type).toBe('cli.install')
    expect(body.events[0].payload.foo).toBe('bar')

    delete process.env.BASELINE_CLOUD_URL
    delete process.env.BASELINE_CLOUD_TOKEN
    fetchSpy.mockRestore()
  })
})

describe('addon > public re-exports', () => {
  it('re-exports login, logout, openspec, hooks commands', async () => {
    const mod = await import('../src/index')
    expect(typeof mod.login).toBe('function')
    expect(typeof mod.logout).toBe('function')
    expect(typeof mod.openspecNew).toBe('function')
    expect(typeof mod.openspecList).toBe('function')
    expect(typeof mod.openspecClose).toBe('function')
    expect(typeof mod.openspecSync).toBe('function')
    expect(typeof mod.hooksInstall).toBe('function')
    expect(typeof mod.hooksUninstall).toBe('function')
    expect(typeof mod.hooksStatus).toBe('function')
    expect(typeof mod.hooksFireCommit).toBe('function')
  })

  it('re-exports auth helpers', async () => {
    const mod = await import('../src/index')
    expect(typeof mod.loadConfig).toBe('function')
    expect(typeof mod.saveConfig).toBe('function')
    expect(typeof mod.clearConfig).toBe('function')
    expect(typeof mod.tokenPrefix).toBe('function')
  })

  it('re-exports telemetry helpers', async () => {
    const mod = await import('../src/index')
    expect(typeof mod.track).toBe('function')
    expect(typeof mod.flush).toBe('function')
    expect(typeof mod.isEnabled).toBe('function')
    expect(typeof mod.parseEstimate).toBe('function')
  })
})
