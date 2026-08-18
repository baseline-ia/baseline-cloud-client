import path from 'node:path'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { track, flush } from '../telemetry'
import { logger } from '../logger'
import { resolveProjectIdentity } from '../project-identity'

const KIRO_SESSIONS_DIR = join(homedir(), '.kiro', 'sessions')
const KIRO_CLI_DIR = join(KIRO_SESSIONS_DIR, 'cli')
const SCAN_STATE_FILE = join(homedir(), '.config', 'baseline-cloud', 'kiro-scan.json')

type LifecycleStatus = 'started' | 'completed' | 'failed'

interface SessionStateEntry {
  turnsProcessed: number
  lastSeen: string
  lifecycle: LifecycleStatus
}

interface ScanState {
  sessions: Record<string, SessionStateEntry>
}

interface SessionSummary {
  credits: number
  turnsProcessed: number
  lastEventStatus: 'success' | 'aborted' | null
}

function loadScanState(): ScanState {
  if (!existsSync(SCAN_STATE_FILE)) return { sessions: {} }
  try {
    return JSON.parse(readFileSync(SCAN_STATE_FILE, 'utf8')) as ScanState
  } catch {
    return { sessions: {} }
  }
}

function saveScanState(state: ScanState): void {
  const dir = path.dirname(SCAN_STATE_FILE)
  mkdirSync(dir, { recursive: true })
  writeFileSync(SCAN_STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8')
}

async function aggregateSession(messagesPath: string): Promise<SessionSummary> {
  let credits = 0
  let turnsProcessed = 0
  let lastEventStatus: 'success' | 'aborted' | null = null

  const rl = createInterface({
    input: createReadStream(messagesPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as any
      const p = entry?.payload
      if (!p) continue

      if (p.type === 'usage_summary') {
        const summaries: any[] = p.promptTurnSummaries ?? []
        for (const s of summaries) credits += s.usage ?? 0
        turnsProcessed++
      } else if (p.type === 'session_event' && p.category === 'session_pause') {
        lastEventStatus = p.context?.status === 'aborted' ? 'aborted' : 'success'
      }
    } catch {
      // malformed line — skip
    }
  }

  return { credits, turnsProcessed, lastEventStatus }
}

function readIdeMeta(sessionDir: string): {
  title: string
  workspaceDir: string
  createdAt: string
  agentMode: string
  status: string
} | null {
  const metaPath = join(sessionDir, 'session.json')
  if (!existsSync(metaPath)) return null
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as any
    return {
      title: meta.title ?? '',
      workspaceDir: (meta.workspacePaths?.[0] ?? '') as string,
      createdAt: meta.createdAt ?? new Date().toISOString(),
      agentMode: meta.agentMode ?? '',
      status: meta.status ?? '',
    }
  } catch {
    return null
  }
}

function readCliMeta(jsonPath: string): {
  title: string
  workspaceDir: string
  createdAt: string
} | null {
  if (!existsSync(jsonPath)) return null
  try {
    const meta = JSON.parse(readFileSync(jsonPath, 'utf8')) as any
    return {
      title: meta.title ?? '',
      workspaceDir: meta.cwd ?? '',
      createdAt: meta.created_at ?? new Date().toISOString(),
    }
  } catch {
    return null
  }
}

function ideSessionLifecycle(sessionStatus: string): LifecycleStatus {
  if (sessionStatus === 'idle') return 'completed'
  if (sessionStatus === 'failed') return 'failed'
  return 'started'
}

function cliSessionLifecycle(lastEventStatus: 'success' | 'aborted' | null): LifecycleStatus {
  if (lastEventStatus === 'success') return 'completed'
  if (lastEventStatus === 'aborted') return 'failed'
  return 'started'
}

async function scanIde(state: ScanState, dryRun: boolean): Promise<{ sessions: number; credits: number }> {
  if (!existsSync(KIRO_SESSIONS_DIR)) return { sessions: 0, credits: 0 }

  let newSessions = 0
  let totalCredits = 0

  const workspaceIds = readdirSync(KIRO_SESSIONS_DIR).filter(
    (f) => f !== 'cli' && statSync(join(KIRO_SESSIONS_DIR, f)).isDirectory()
  )

  for (const wsId of workspaceIds) {
    const wsDir = join(KIRO_SESSIONS_DIR, wsId)
    const sessionIds = readdirSync(wsDir).filter(
      (f) => statSync(join(wsDir, f)).isDirectory()
    )

    for (const sessId of sessionIds) {
      const sessDir = join(wsDir, sessId)
      const messagesPath = join(sessDir, 'messages.jsonl')
      if (!existsSync(messagesPath)) continue

      const stateKey = `${wsId}/${sessId}`
      const { credits, turnsProcessed } = await aggregateSession(messagesPath)
      const meta = readIdeMeta(sessDir)
      const lifecycle = ideSessionLifecycle(meta?.status ?? '')
      const project = resolveProjectIdentity(meta?.workspaceDir || wsId)
      const prev = state.sessions[stateKey]

      const isNew = !prev
      const lifecycleChanged = prev && prev.lifecycle !== lifecycle && lifecycle !== 'started'
      const creditsChanged = turnsProcessed > (prev?.turnsProcessed ?? 0) && credits > 0

      if (!isNew && !lifecycleChanged && !creditsChanged) continue

      if (!dryRun) {
        const base = {
          sessionId: sessId,
          workspaceId: wsId,
          title: meta?.title ?? '',
          agentMode: meta?.agentMode ?? '',
          clientType: 'kiro-ide',
          tool: 'kiro',
        }

        if (isNew) {
          track({ event_type: 'session.started', project, payload: { ...base, createdAt: meta?.createdAt ?? '' } })
        }

        if (creditsChanged) {
          track({
            event_type: 'session.credits',
            project,
            payload: { ...base, credits: Math.round(credits * 1000) / 1000, turnsProcessed },
          })
        }

        if (lifecycleChanged) {
          const eventType = lifecycle === 'completed' ? 'session.completed' : 'session.failed'
          track({ event_type: eventType, project, payload: { ...base, credits: Math.round(credits * 1000) / 1000, turnsProcessed } })
        }

        state.sessions[stateKey] = {
          turnsProcessed,
          lastSeen: new Date().toISOString(),
          lifecycle: isNew ? 'started' : lifecycle,
        }
      }

      if (creditsChanged || isNew) {
        newSessions++
        totalCredits += credits
      }
    }
  }

  return { sessions: newSessions, credits: totalCredits }
}

async function scanCli(state: ScanState, dryRun: boolean): Promise<{ sessions: number; credits: number }> {
  if (!existsSync(KIRO_CLI_DIR)) return { sessions: 0, credits: 0 }

  let newSessions = 0
  let totalCredits = 0

  const jsonFiles = readdirSync(KIRO_CLI_DIR).filter((f) => f.endsWith('.json'))

  for (const jsonFile of jsonFiles) {
    const uuid = jsonFile.replace(/\.json$/, '')
    const jsonPath = join(KIRO_CLI_DIR, jsonFile)
    const messagesPath = join(KIRO_CLI_DIR, `${uuid}.jsonl`)
    if (!existsSync(messagesPath)) continue

    const stateKey = `cli/${uuid}`
    const { credits, turnsProcessed, lastEventStatus } = await aggregateSession(messagesPath)
    const meta = readCliMeta(jsonPath)
    const lifecycle = cliSessionLifecycle(lastEventStatus)
    const project = resolveProjectIdentity(meta?.workspaceDir || uuid)
    const prev = state.sessions[stateKey]

    const isNew = !prev
    const lifecycleChanged = prev && prev.lifecycle !== lifecycle && lifecycle !== 'started'
    const creditsChanged = turnsProcessed > (prev?.turnsProcessed ?? 0) && credits > 0

    if (!isNew && !lifecycleChanged && !creditsChanged) continue

    if (!dryRun) {
      const base = {
        sessionId: uuid,
        workspaceId: uuid,
        title: meta?.title ?? '',
        agentMode: 'cli',
        clientType: 'kiro-cli',
        tool: 'kiro',
      }

      if (isNew) {
        track({ event_type: 'session.started', project, payload: { ...base, createdAt: meta?.createdAt ?? '' } })
      }

      if (creditsChanged) {
        track({
          event_type: 'session.credits',
          project,
          payload: { ...base, credits: Math.round(credits * 1000) / 1000, turnsProcessed },
        })
      }

      if (lifecycleChanged) {
        const eventType = lifecycle === 'completed' ? 'session.completed' : 'session.failed'
        track({ event_type: eventType, project, payload: { ...base, credits: Math.round(credits * 1000) / 1000, turnsProcessed } })
      }

      state.sessions[stateKey] = {
        turnsProcessed,
        lastSeen: new Date().toISOString(),
        lifecycle: isNew ? 'started' : lifecycle,
      }
    }

    if (creditsChanged || isNew) {
      newSessions++
      totalCredits += credits
    }
  }

  return { sessions: newSessions, credits: totalCredits }
}

export async function kiroScan(opts: { dryRun?: boolean } = {}): Promise<void> {
  if (!existsSync(KIRO_SESSIONS_DIR)) {
    logger.warn('~/.kiro/sessions not found — is Kiro installed?')
    return
  }

  const state = loadScanState()
  const dryRun = opts.dryRun ?? false

  const [ide, cli] = await Promise.all([
    scanIde(state, dryRun),
    scanCli(state, dryRun),
  ])

  const newSessions = ide.sessions + cli.sessions
  const totalCredits = ide.credits + cli.credits

  if (!dryRun && newSessions > 0) {
    await flush()
    saveScanState(state)
  }

  if (newSessions === 0) {
    logger.dim('  · No new Kiro sessions to report')
  } else {
    logger.success(
      `✓ Tracked ${newSessions} session${newSessions !== 1 ? 's' : ''} (${(Math.round(totalCredits * 1000) / 1000).toLocaleString()} credits total)`
    )
  }
}
