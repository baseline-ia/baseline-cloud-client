import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Command } from 'commander'
import {
  buildCloudCommand,
  buildKiroCommand,
  buildProjectCommand,
  buildUpdateCommand,
  register,
  type PluginContext,
  type TelemetryEventLike,
} from '../src/index'

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
    const optionFlags = login.options.map((o) => o.long ?? o.short).filter(Boolean)
    expect(optionFlags).toContain('--server')
    expect(optionFlags).toContain('--username')
    expect(optionFlags).toContain('--password')
  })
})

describe('addon > buildKiroCommand', () => {
  it('builds a Command named "kiro" with scan subcommand', () => {
    const cmd = buildKiroCommand()
    expect(cmd.name()).toBe('kiro')
    const subNames = cmd.commands.map((c) => c.name())
    expect(subNames).toEqual(['scan', 'sync', 'watch'])
  })

  it('scan subcommand has --dry-run option', () => {
    const cmd = buildKiroCommand()
    const scan = cmd.commands.find((c) => c.name() === 'scan')!
    const optionFlags = scan.options.map((o) => o.long ?? o.short).filter(Boolean)
    expect(optionFlags).toContain('--dry-run')
  })
})

describe('addon > buildProjectCommand', () => {
  it('registers project init and enroll commands', () => {
    const cmd = buildProjectCommand()
    expect(cmd.commands.map((c) => c.name())).toEqual(['init', 'enroll'])
    const init = cmd.commands[0]!
    expect(init.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--slug', '--path', '--force']))
    const enroll = cmd.commands[1]!
    expect(enroll.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--slug', '--path', '--name']))
  })
})

describe('addon > buildUpdateCommand', () => {
  it('registers the update command with no subcommands or options', () => {
    const cmd = buildUpdateCommand()
    expect(cmd.name()).toBe('update')
    expect(cmd.commands).toHaveLength(0)
    expect(cmd.options).toHaveLength(0)
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

  it('registers cloud, kiro, project, and update subcommands', async () => {
    const ctx = makePluginContext()
    await register(ctx)
    const names = ctx.registeredCommands.map((c) => c.name()).sort()
    expect(names).toEqual(['cloud', 'kiro', 'project', 'update'])
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

    process.env.BASELINE_CLOUD_URL = 'https://x.test'
    process.env.BASELINE_CLOUD_TOKEN = 't'
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as any)

    await handler({ event_type: 'cli.install', project: 'p', payload: { foo: 'bar' } })
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
  it('re-exports login, logout, and kiroScan', async () => {
    const mod = await import('../src/index')
    expect(typeof mod.login).toBe('function')
    expect(typeof mod.logout).toBe('function')
    expect(typeof mod.kiroScan).toBe('function')
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
