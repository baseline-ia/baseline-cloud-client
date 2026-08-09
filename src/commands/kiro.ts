import path from 'node:path'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { track, flush } from '../telemetry'
import { logger } from '../logger'
import { resolveProjectIdentity } from '../project-identity'

const KIRO_SESSIONS_DIR = join(homedir(), '.kiro', 'sessions')
const SCAN_STATE_FILE = join(homedir(), '.config', 'baseline-cloud', 'kiro-scan.json')

interface SessionSummary {
  credits: number
  turnsProcessed: number
}

interface ScanState {
  sessions: Record<string, { turnsProcessed: number; lastSeen: string }>
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

async function aggregateSessionCredits(messagesPath: string): Promise<SessionSummary> {
  let credits = 0
  let turnsProcessed = 0

  const rl = createInterface({
    input: createReadStream(messagesPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as any
      const p = entry?.payload
      if (!p || p.type !== 'usage_summary') continue
      const summaries: any[] = p.promptTurnSummaries ?? []
      for (const s of summaries) {
        credits += s.usage ?? 0
      }
      turnsProcessed++
    } catch {
      // malformed line — skip
    }
  }

  return { credits, turnsProcessed }
}

function readSessionMeta(sessionDir: string): { title: string; workspaceDir: string; createdAt: string } | null {
  const metaPath = join(sessionDir, 'session.json')
  if (!existsSync(metaPath)) return null
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as any
    return {
      title: meta.title ?? '',
      workspaceDir: (meta.workspacePaths?.[0] ?? '') as string,
      createdAt: meta.createdAt ?? new Date().toISOString(),
    }
  } catch {
    return null
  }
}

export async function kiroScan(opts: { dryRun?: boolean } = {}): Promise<void> {
  if (!existsSync(KIRO_SESSIONS_DIR)) {
    logger.warn('~/.kiro/sessions not found — is Kiro installed?')
    return
  }

  const state = loadScanState()
  let newSessions = 0
  let totalCredits = 0

  const workspaceIds = readdirSync(KIRO_SESSIONS_DIR).filter(
    (f) => statSync(join(KIRO_SESSIONS_DIR, f)).isDirectory()
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
      const { credits, turnsProcessed } = await aggregateSessionCredits(messagesPath)

      const prev = state.sessions[stateKey]
      if (prev && prev.turnsProcessed >= turnsProcessed) continue
      if (credits === 0) continue

      const meta = readSessionMeta(sessDir)
       const project = resolveProjectIdentity(meta?.workspaceDir || wsId)

      if (!opts.dryRun) {
        track({
          event_type: 'session.credits',
          project,
          payload: {
            sessionId: sessId,
            workspaceId: wsId,
            credits: Math.round(credits * 1000) / 1000,
            turnsProcessed,
            title: meta?.title ?? '',
            tool: 'kiro',
          },
        })

        state.sessions[stateKey] = {
          turnsProcessed,
          lastSeen: new Date().toISOString(),
        }
      }

      newSessions++
      totalCredits += credits
    }
  }

  if (!opts.dryRun && newSessions > 0) {
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
