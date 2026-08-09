import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { getBaselineConfigDir } from '../auth'
import { logger } from '../logger'
import { deliverEvents, type EventPayload } from '../telemetry'
import { resolveProjectIdentity } from '../project-identity'

export const SDD_PHASES = ['explore', 'propose', 'spec', 'design', 'tasks', 'apply', 'verify', 'archive'] as const
export type SddPhase = (typeof SDD_PHASES)[number]

interface PhaseState { phase: SddPhase; change: string; project: string; startedAt: string }
interface PendingEvent { event: EventPayload; kind: 'started' | 'completed'; stateKey: string }
interface StateFile { phases: Record<string, PhaseState>; events: Record<string, PendingEvent> }

function statePath(): string { return path.join(getBaselineConfigDir(), 'sdd-phase-state.json') }
function stateKey(phase: SddPhase, change: string, project: string): string { return JSON.stringify([project, change, phase]) }

function loadState(): StateFile {
  if (!existsSync(statePath())) return { phases: {}, events: {} }
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<StateFile>
    return {
      phases: parsed.phases && typeof parsed.phases === 'object' ? parsed.phases : {},
      events: parsed.events && typeof parsed.events === 'object' ? parsed.events : {},
    }
  } catch {
    return { phases: {}, events: {} }
  }
}

function saveState(state: StateFile): void {
  mkdirSync(getBaselineConfigDir(), { recursive: true })
  writeFileSync(statePath(), JSON.stringify(state, null, 2), { mode: 0o600 })
}

function removeStateFileIfEmpty(state: StateFile): void {
  if (Object.keys(state.phases).length === 0 && Object.keys(state.events).length === 0 && existsSync(statePath())) unlinkSync(statePath())
  else saveState(state)
}

function validatePhase(phase: string): SddPhase {
  if ((SDD_PHASES as readonly string[]).includes(phase)) return phase as SddPhase
  throw new Error(`Invalid SDD phase '${phase}'. Use one of: ${SDD_PHASES.join(', ')}.`)
}

function requireValue(value: string | undefined, label: string): string {
  const trimmed = value?.trim()
  if (!trimmed) throw new Error(`--${label} is required.`)
  return trimmed
}

function createStartedEvent(phase: SddPhase, change: string, project: string, startedAt: string): EventPayload {
  return { event_type: 'sdd.phase.started', project, occurred_at: startedAt, payload: { phase, change, project, startedAt } }
}

async function persistAndDeliver(state: StateFile, eventKey: string, pending: PendingEvent): Promise<boolean> {
  state.events[eventKey] = pending
  saveState(state)
  if (!await deliverEvents([pending.event])) return false
  delete state.events[eventKey]
  return true
}

export async function sddPhaseStart(opts: { phase: string; change: string; project?: string }): Promise<void> {
  const phase = validatePhase(opts.phase)
  const change = requireValue(opts.change, 'change')
  const project = resolveProjectIdentity(opts.project)
  const state = loadState()
  const key = stateKey(phase, change, project)
  if (state.phases[key]) throw new Error(`SDD phase '${phase}' is already started for change '${change}' in project '${project}'.`)

  const startedAt = new Date().toISOString()
  state.phases[key] = { phase, change, project, startedAt }
  const eventKey = key + ':started'
  const delivered = await persistAndDeliver(state, eventKey, {
    event: createStartedEvent(phase, change, project, startedAt), kind: 'started', stateKey: key,
  })
  removeStateFileIfEmpty(state)
  logger.success(`✓ SDD phase started: ${phase} [${change}]${delivered ? '' : ' (pending telemetry)'}`)
}

function completionEvent(started: PhaseState, completedAt: string, status?: 'completed' | 'failed'): EventPayload {
  return {
    event_type: 'sdd.phase.completed', project: started.project, occurred_at: completedAt,
    payload: {
      phase: started.phase, change: started.change, project: started.project,
      startedAt: started.startedAt, completedAt,
      durationSeconds: Math.max(0, (Date.parse(completedAt) - Date.parse(started.startedAt)) / 1000),
      ...(status ? { status } : {}),
    },
  }
}

async function completeState(opts: { phase: string; change: string; project?: string }, status?: 'completed' | 'failed'): Promise<void> {
  const phase = validatePhase(opts.phase)
  const change = requireValue(opts.change, 'change')
  const project = resolveProjectIdentity(opts.project)
  const state = loadState()
  const key = stateKey(phase, change, project)
  const started = state.phases[key]
  if (!started) throw new Error(`No started SDD phase found for '${phase}' and change '${change}' in project '${project}'.`)
  const eventKey = key + ':completed'
  const delivered = await persistAndDeliver(state, eventKey, {
    event: completionEvent(started, new Date().toISOString(), status), kind: 'completed', stateKey: key,
  })
  if (delivered) delete state.phases[key]
  removeStateFileIfEmpty(state)
  if (!delivered) logger.warn(`SDD phase completion pending telemetry: ${phase} [${change}]`)
  else logger.success(`✓ SDD phase completed: ${phase} [${change}]`)
}

export async function sddPhaseComplete(opts: { phase: string; change: string; project?: string }): Promise<void> {
  await completeState(opts)
}

/** Replay durable SDD events. Only confirmed 2xx deliveries are removed. */
export async function syncSddPhaseEvents(): Promise<number> {
  const state = loadState()
  let delivered = 0
  for (const [eventKey, pending] of Object.entries(state.events)) {
    if (!await deliverEvents([pending.event])) continue
    delete state.events[eventKey]
    if (pending.kind === 'completed') delete state.phases[pending.stateKey]
    delivered++
    removeStateFileIfEmpty(state)
  }
  return delivered
}

/** Run a child command while timing one SDD phase in this process. */
export async function sddPhaseRun(opts: { phase: string; change: string; project?: string; command: string; args?: string[] }): Promise<number> {
  await sddPhaseStart(opts)
  let exitCode = 1
  let status: 'completed' | 'failed' = 'failed'
  try {
    exitCode = await new Promise<number>((resolve) => {
      const child = spawn(opts.command, opts.args ?? [], { stdio: 'inherit' })
      child.once('error', () => resolve(1))
      child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    })
    status = exitCode === 0 ? 'completed' : 'failed'
    return exitCode
  } finally {
    await completeState(opts, status)
  }
}
