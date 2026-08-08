/**
 * Cloud addon command: `baseline openspec <subcommand>`.
 *
 * Manages the local OpenSpec change directory and fires the
 * corresponding events to the cloud:
 *
 *   baseline openspec new <name> [--type feature|migration|new-project|...] [--estimate small|medium|large|xlarge|240|4h]
 *     Create a new change directory with a proposal.md scaffold and
 *     fire `change.open` with the work type and estimate.
 *
 *   baseline openspec list
 *     Show active and archived changes in the current project.
 *
 *   baseline openspec close <name>
 *     Archive the change (move to openspec/changes/archive/) and fire
 *     `change.close` with the duration and verdict.
 *
 *   baseline openspec sync
 *     Scan for new/closed changes and fire the corresponding events.
 *     Safe to run on every CLI invocation; idempotent.
 */
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  statSync,
  renameSync,
} from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger'
import { track, parseEstimate, type WorkType } from '../telemetry'
import { syncOpenspecChanges, readProposalFrontmatter } from '../openspec-tracker'

const VALID_TYPES: WorkType[] = [
  'feature',
  'migration',
  'new-project',
  'chore',
  'fix',
  'refactor',
  'docs',
]

function findProjectRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'openspec', 'changes'))) return dir
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

function changeDir(root: string, name: string): string {
  return join(root, 'openspec', 'changes', name)
}

/**
 * Build the proposal.md scaffold for a new change.
 *
 * The scaffold includes:
 *  - YAML frontmatter (title, type, optional estimate)
 *  - "Why", "What changes", "Out of scope", "Impact", "Success criteria"
 *    sections (the dev fills them in)
 *  - A "Time estimate" section that references the ROI calculation
 *    (so the dev knows why they were asked for an estimate)
 */
function buildProposal(
  name: string,
  type: WorkType,
  estimateMin: number | null,
  estimateBucket: string | null
): string {
  const fmLines = ['---']
  fmLines.push(`title: "${name}"`)
  fmLines.push(`type: ${type}`)
  if (estimateMin !== null) {
    fmLines.push(`estimate_min: ${estimateMin}`)
  }
  if (estimateBucket) {
    fmLines.push(`estimate_bucket: ${estimateBucket}`)
  }
  fmLines.push('---', '')

  const estimateLine =
    estimateMin !== null
      ? `**Estimated time without baseline**: ~${Math.round((estimateMin / 60) * 10) / 10}h${
          estimateBucket ? ` (bucket: ${estimateBucket})` : ''
        }.`
      : `_No estimate provided — ROI will use the admin default for this work type._`

  return `${fmLines.join('\n')}# Proposal: ${name}

## Why

[Why this change is needed — 2-3 sentences.]

## What changes

- [Bullet list of changes]

## Out of scope

- [Explicit non-goals]

## Impact

Files touched, LoC estimate, risk.

## Success criteria

- [ ] Measurable criterion 1
- [ ] Measurable criterion 2

## Time estimate (for ROI)

${estimateLine}

## Follow-ups

- [Future work this unlocks]
`
}

export async function openspecNew(
  name: string,
  opts: { type?: string; estimate?: string; cwd?: string } = {}
): Promise<void> {
  if (!name || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(name)) {
    logger.error('Change name must be kebab-case, 3-64 chars: e.g. "add-vitest-coverage"')
    process.exit(1)
  }
  const type = (opts.type ?? 'feature') as WorkType
  if (!VALID_TYPES.includes(type)) {
    logger.error(`Invalid type '${type}'. Must be one of: ${VALID_TYPES.join(', ')}`)
    process.exit(1)
  }

  // Parse the estimate (optional). Bucket or explicit number.
  let estimateMin: number | null = null
  let estimateBucket: string | null = null
  if (opts.estimate) {
    try {
      const parsed = parseEstimate(opts.estimate)
      estimateMin = parsed.minutes
      estimateBucket = parsed.bucket ?? null
    } catch (err) {
      logger.error((err as Error).message)
      process.exit(1)
    }
  }

  const root = opts.cwd ?? findProjectRoot()
  const dir = changeDir(root, name)
  if (existsSync(dir)) {
    logger.error(`Change '${name}' already exists at ${dir}`)
    process.exit(1)
  }
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'specs'), { recursive: true })

  const proposalPath = join(dir, 'proposal.md')
  const proposal = buildProposal(name, type, estimateMin, estimateBucket)
  writeFileSync(proposalPath, proposal)

  logger.success(`✓ Created change '${name}' (type=${type}) at ${dir}`)
  if (estimateMin !== null) {
    const hours = Math.round((estimateMin / 60) * 10) / 10
    logger.info(
      `  Estimated time without baseline: ${hours}h${
        estimateBucket ? ` (bucket: ${estimateBucket})` : ''
      }`
    )
    logger.info(`  ROI will compare actual open→close time against this estimate.`)
  } else {
    logger.warn(`  No estimate provided. ROI will use the admin default for work type '${type}'.`)
    logger.info(
      `  To set an estimate, re-run: baseline openspec edit ${name}  (or pass --estimate next time)`
    )
  }
  logger.info(`  Next: edit ${proposalPath} to fill in the proposal.`)

  // Fire change.open event with the estimate
  track({
    event_type: 'change.open',
    project: 'default',
    payload: {
      changeName: name,
      workType: type,
      title: name,
      ...(estimateMin !== null ? { estimateMin } : {}),
      ...(estimateBucket ? { estimateBucket } : {}),
      estimateSource: estimateMin !== null ? (estimateBucket ? 'bucket' : 'per-change') : 'admin-default',
    },
  })

  syncOpenspecChanges(root)
}

export async function openspecList(opts: { cwd?: string } = {}): Promise<void> {
  const root = opts.cwd ?? findProjectRoot()
  const changesDir = join(root, 'openspec', 'changes')
  if (!existsSync(changesDir)) {
    logger.info('No openspec/changes/ directory found in this project.')
    return
  }
  const dirs = readdirSync(changesDir).filter((n) => {
    try {
      return statSync(join(changesDir, n)).isDirectory()
    } catch {
      return false
    }
  })
  if (dirs.length === 0) {
    logger.info('No active changes.')
    return
  }

  const archiveDir = join(root, 'openspec', 'changes', 'archive')
  const archived = existsSync(archiveDir)
    ? readdirSync(archiveDir).filter((n) => {
        try {
          return statSync(join(archiveDir, n)).isDirectory()
        } catch {
          return false
        }
      })
    : []

  logger.title('Active OpenSpec changes')
  for (const name of dirs) {
    const proposalPath = join(changesDir, name, 'proposal.md')
    const { workType, title, estimateMin } = readProposalFrontmatter(proposalPath)
    const est = estimateMin ? `, est ${Math.round((estimateMin / 60) * 10) / 10}h` : ''
    logger.info(`  ${name} [${workType}${est}] — ${title ?? '(no title)'}`)
  }
  if (archived.length > 0) {
    logger.title('Archived changes')
    for (const name of archived.slice(0, 10)) {
      logger.info(`  ${name}`)
    }
    if (archived.length > 10) logger.info(`  ... and ${archived.length - 10} more`)
  }
}

export async function openspecClose(
  name: string,
  opts: { cwd?: string } = {}
): Promise<void> {
  const root = opts.cwd ?? findProjectRoot()
  const dir = changeDir(root, name)
  if (!existsSync(dir)) {
    logger.error(`Change '${name}' not found at ${dir}`)
    process.exit(1)
  }

  let openedAt: number
  try {
    openedAt = statSync(dir).mtimeMs
  } catch {
    openedAt = Date.now()
  }
  const durationMs = Date.now() - openedAt

  // Read the estimate from proposal.md (if present) so close has it too
  const proposalPath = join(dir, 'proposal.md')
  const { estimateMin } = readProposalFrontmatter(proposalPath)

  const today = new Date().toISOString().slice(0, 10)
  const archiveDir = join(root, 'openspec', 'changes', 'archive', `${today}-${name}`)
  if (existsSync(archiveDir)) {
    logger.error(`Archive target already exists: ${archiveDir}`)
    process.exit(1)
  }
  mkdirSync(join(root, 'openspec', 'changes', 'archive'), { recursive: true })
  renameSync(dir, archiveDir)
  logger.success(`✓ Archived change '${name}' to ${archiveDir}`)

  // Read the workType from the (now-moved) proposal
  const archivedProposalPath = join(archiveDir, 'proposal.md')
  const { workType } = readProposalFrontmatter(archivedProposalPath)
  const actualHours = Math.round(durationMs / 36000) / 10
  if (estimateMin) {
    const estimatedHours = Math.round((estimateMin / 60) * 10) / 10
    const savedMin = Math.max(0, estimateMin - durationMs / 60_000)
    const savedHours = Math.round((savedMin / 60) * 10) / 10
    const roiPct = Math.round((savedMin / estimateMin) * 1000) / 10
    logger.info(`  Estimated without baseline: ${estimatedHours}h`)
    logger.info(`  Actual with baseline:       ${actualHours}h`)
    logger.info(`  Time saved:                 ${savedHours}h (${roiPct}% ROI)`)
  } else {
    logger.info(`  Actual time: ${actualHours}h (no estimate was set, ROI uses admin default)`)
  }

  track({
    event_type: 'change.close',
    project: 'default',
    payload: {
      changeName: name,
      workType,
      totalCommits: 0,
      durationMs,
      verdict: 'archived',
      ...(estimateMin ? { estimateMin } : {}),
    },
  })
}

export function openspecSync(): void {
  const root = findProjectRoot()
  syncOpenspecChanges(root)
  logger.success('✓ Synced OpenSpec changes with the cloud.')
}
