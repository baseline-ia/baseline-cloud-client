import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import packageJson from '../package.json'

const root = join(__dirname, '..')

describe('baseline-cloud conversational skill', () => {
  it('has the required runtime contract and local reference', () => {
    const skill = readFileSync(join(root, 'skills', 'baseline-cloud-workflow', 'SKILL.md'), 'utf8')
    const reference = readFileSync(join(root, 'skills', 'baseline-cloud-workflow', 'references', 'command-contracts.md'), 'utf8')

    expect(skill).toContain('name: baseline-cloud-workflow')
    expect(skill).toContain('## Activation Contract')
    expect(skill).toContain('## Hard Rules')
    expect(skill).toContain('## Decision Gates')
    expect(skill).toContain('## Execution Steps')
    expect(skill).toContain('## Output Contract')
    expect(skill).toContain('## References')
    expect(skill).toContain('baseline-cloud sdd phase run --phase ... --change ... --project ... -- <command>')
    expect(skill).toContain('baseline-cloud telemetry sync')
    expect(reference).toContain('Credentials stay in `~/.baseline/cloud.json`.')
  })

  it('publishes the skills directory', () => {
    expect(packageJson.files).toContain('skills')
  })
})
