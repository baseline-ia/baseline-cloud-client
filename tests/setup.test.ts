import { describe, expect, it } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installWorkflowSkill } from '../src/commands/setup'

describe('baseline-cloud workflow skill installation', () => {
  it('installs into a supported tool skill directory and preserves it on repeat', () => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-skill-'))
    const source = join(root, 'source.md')
    const destinationRoot = join(root, 'tool')
    writeFileSync(source, 'canonical skill\n', 'utf8')

    expect(installWorkflowSkill(destinationRoot, source)).toBe(true)
    const destination = join(destinationRoot, 'skills', 'baseline-cloud-workflow', 'SKILL.md')
    expect(existsSync(destination)).toBe(true)
    expect(readFileSync(destination, 'utf8')).toBe('canonical skill\n')

    writeFileSync(source, 'changed canonical skill\n', 'utf8')
    expect(installWorkflowSkill(destinationRoot, source)).toBe(true)
    expect(readFileSync(destination, 'utf8')).toBe('canonical skill\n')
  })
})
