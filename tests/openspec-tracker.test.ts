import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs-extra'
import os from 'os'
import path from 'path'

let tmpHome: string
let tmpProject: string

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-client-ost-home-'))
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-client-ost-proj-'))
  // Enable telemetry by default for sync tests
  process.env.BASELINE_CLOUD_URL = 'https://x.test'
  process.env.BASELINE_CLOUD_TOKEN = 't'
  delete process.env.BASELINE_TELEMETRY
  // Mock fetch to swallow the POST
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
  } as any)
})

afterEach(async () => {
  await fs.remove(tmpHome).catch(() => {})
  await fs.remove(tmpProject).catch(() => {})
  delete process.env.BASELINE_CLOUD_URL
  delete process.env.BASELINE_CLOUD_TOKEN
  vi.restoreAllMocks()
})

async function loadTracker() {
  const tracker = await import('../src/openspec-tracker')
  const telemetry = await import('../src/telemetry')
  const auth = await import('../src/auth')
  telemetry._resetForTests()
  auth._resetConfigForTests()
  auth._setHomedirForTests(tmpHome)
  return { ...tracker, telemetry, auth }
}

describe('openspec-tracker > readProposalFrontmatter', () => {
  it('returns defaults when the file does not exist', async () => {
    const { readProposalFrontmatter } = await loadTracker()
    const meta = readProposalFrontmatter('/nonexistent/proposal.md')
    expect(meta.workType).toBe('feature')
    expect(meta.title).toBeUndefined()
  })

  it('parses YAML frontmatter (type, title, estimate, bucket)', async () => {
    const { readProposalFrontmatter } = await loadTracker()
    const proposalPath = path.join(tmpProject, 'proposal.md')
    await fs.writeFile(
      proposalPath,
      `---
title: "Add dark mode"
type: feature
estimate_min: 240
estimate_bucket: medium
---

# Proposal: Add dark mode
`
    )
    const meta = readProposalFrontmatter(proposalPath)
    expect(meta.workType).toBe('feature')
    expect(meta.title).toBe('Add dark mode')
    expect(meta.estimateMin).toBe(240)
    expect(meta.estimateBucket).toBe('medium')
  })

  it('extracts the title from the first heading when frontmatter is missing', async () => {
    const { readProposalFrontmatter } = await loadTracker()
    const proposalPath = path.join(tmpProject, 'proposal.md')
    await fs.writeFile(proposalPath, `# Proposal: Migrate to Postgres\n\nSome body.`)
    const meta = readProposalFrontmatter(proposalPath)
    expect(meta.title).toBe('Migrate to Postgres')
    expect(meta.workType).toBe('feature')
  })

  it('returns just workType when the frontmatter is malformed', async () => {
    const { readProposalFrontmatter } = await loadTracker()
    const proposalPath = path.join(tmpProject, 'proposal.md')
    await fs.writeFile(proposalPath, `---\nthis is: : not valid\n---\nbody`)
    // The parser is lenient; should not throw.
    const meta = readProposalFrontmatter(proposalPath)
    expect(meta.workType).toBe('feature')
  })

  it('coerces a missing type to "feature" (default)', async () => {
    const { readProposalFrontmatter } = await loadTracker()
    const proposalPath = path.join(tmpProject, 'proposal.md')
    await fs.writeFile(
      proposalPath,
      `---
title: "Untyped change"
---

# Body`
    )
    expect(readProposalFrontmatter(proposalPath).workType).toBe('feature')
  })
})

describe('openspec-tracker > syncOpenspecChanges', () => {
  it('does nothing when there is no openspec/changes/ directory', async () => {
    const { syncOpenspecChanges } = await loadTracker()
    await expect(() => syncOpenspecChanges(tmpProject)).not.toThrow()
  })

  it('fires change.open for a new change directory', async () => {
    const changeDir = path.join(tmpProject, 'openspec', 'changes', 'add-vitest')
    await fs.ensureDir(changeDir)
    await fs.writeFile(
      path.join(changeDir, 'proposal.md'),
      `---
type: feature
title: "Add vitest"
estimate_min: 60
---

# Add vitest`
    )
    const { syncOpenspecChanges } = await loadTracker()
    syncOpenspecChanges(tmpProject)
    // Wait for the auto-flush
    await new Promise((r) => setTimeout(r, 50))
    // Verify a state file was written
    const stateFile = path.join(tmpHome, '.baseline', 'openspec-state.json')
    expect(await fs.pathExists(stateFile)).toBe(true)
  })

  it('is idempotent: second call with no new changes fires nothing', async () => {
    const changeDir = path.join(tmpProject, 'openspec', 'changes', 'add-vitest')
    await fs.ensureDir(changeDir)
    await fs.writeFile(path.join(changeDir, 'proposal.md'), `---\ntype: feature\n---\n`)

    const { syncOpenspecChanges } = await loadTracker()
    const { telemetry } = await loadTracker()
    const fetchSpy = vi.mocked(globalThis.fetch)
    fetchSpy.mockClear()

    syncOpenspecChanges(tmpProject)
    await new Promise((r) => setTimeout(r, 50))
    syncOpenspecChanges(tmpProject) // second call
    await new Promise((r) => setTimeout(r, 50))

    // Only the first call should have caused a fetch (the second is
    // idempotent).
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('fires change.close when a tracked change is removed from the filesystem', async () => {
    const changeDir = path.join(tmpProject, 'openspec', 'changes', 'will-be-closed')
    await fs.ensureDir(changeDir)
    await fs.writeFile(path.join(changeDir, 'proposal.md'), `---\ntype: chore\n---\n`)

    const { syncOpenspecChanges } = await loadTracker()
    // First sync: see the change, track it
    syncOpenspecChanges(tmpProject)
    await new Promise((r) => setTimeout(r, 50))
    // Now remove the change directory (simulating archive)
    await fs.remove(changeDir)
    // Second sync: should fire change.close
    syncOpenspecChanges(tmpProject)
    await new Promise((r) => setTimeout(r, 50))

    // The state file should no longer track this change
    const stateFile = path.join(tmpHome, '.baseline', 'openspec-state.json')
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    expect(state.lastSeenChanges['will-be-closed']).toBeUndefined()
  })
})
