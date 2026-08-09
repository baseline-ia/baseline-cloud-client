import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildNpmInstallArgs, npmExecutable, update, type UpdateProcessRunner } from '../src/commands/update'

describe('baseline-cloud update', () => {
  it('uses npm.cmd on Windows and constructs literal npm arguments', () => {
    expect(npmExecutable('win32')).toBe('npm.cmd')
    expect(npmExecutable('darwin')).toBe('npm')
    expect(buildNpmInstallArgs()).toEqual([
      'install', '--global', '@baseline-ia/baseline-cloud-client@latest',
    ])
  })

  it('updates first, then invokes the freshly installed CLI setup', () => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-update-'))
    const packageRoot = join(root, '@baseline-ia', 'baseline-cloud-client')
    mkdirSync(join(packageRoot, 'dist'), { recursive: true })
    writeFileSync(join(packageRoot, 'dist', 'cli.js'), '')
    writeFileSync(join(packageRoot, 'package.json'), '{"version":"9.9.9"}')
    const calls: Array<{ command: string; args: string[]; stdio: unknown }> = []
    const runner: UpdateProcessRunner = (command, args, options) => {
      calls.push({ command, args, stdio: options.stdio })
      if (args[0] === 'root') return { status: 0, stdout: `${root}\n` }
      return { status: 0 }
    }

    update(runner, 'darwin')

    expect(calls[0]).toMatchObject({ command: 'npm', args: buildNpmInstallArgs(), stdio: 'inherit' })
    expect(calls[1]).toMatchObject({ command: 'npm', args: ['root', '--global'] })
    expect(calls[2]).toMatchObject({ command: process.execPath, args: [join(packageRoot, 'dist', 'cli.js'), 'setup'], stdio: 'inherit' })
  })

  it('fails when npm install fails and does not invoke setup', () => {
    const runner = vi.fn<UpdateProcessRunner>(() => ({ status: 1 }))
    expect(() => update(runner, 'darwin')).toThrow(/npm install failed with status 1/)
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('fails when post-update setup fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-update-'))
    const packageRoot = join(root, '@baseline-ia', 'baseline-cloud-client')
    mkdirSync(join(packageRoot, 'dist'), { recursive: true })
    writeFileSync(join(packageRoot, 'dist', 'cli.js'), '')
    const runner: UpdateProcessRunner = (_command, args) => {
      if (args[0] === 'root') return { status: 0, stdout: `${root}\n` }
      if (args[1] === 'setup') return { status: 1 }
      return { status: 0 }
    }
    expect(() => update(runner, 'darwin')).toThrow(/post-update setup failed with status 1/)
  })

  it('does not modify credential or project identity files', () => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-update-'))
    const packageRoot = join(root, '@baseline-ia', 'baseline-cloud-client')
    mkdirSync(join(packageRoot, 'dist'), { recursive: true })
    writeFileSync(join(packageRoot, 'dist', 'cli.js'), '')
    writeFileSync(join(packageRoot, 'package.json'), '{"version":"9.9.9"}')
    const credentials = join(root, 'cloud.json')
    const project = join(root, 'project.json')
    writeFileSync(credentials, '{"token":"unchanged"}')
    writeFileSync(project, '{"slug":"unchanged"}')
    const runner: UpdateProcessRunner = (_command, args) => {
      if (args[0] === 'root') return { status: 0, stdout: `${root}\n` }
      return { status: 0 }
    }

    update(runner, 'darwin')

    expect(readFileSync(credentials, 'utf8')).toBe('{"token":"unchanged"}')
    expect(readFileSync(project, 'utf8')).toBe('{"slug":"unchanged"}')
  })
})
