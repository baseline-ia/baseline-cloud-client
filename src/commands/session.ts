import path from 'node:path'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { track, flush } from '../telemetry'
import { logger } from '../logger'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * Parse a Claude Code session JSONL and aggregate all token usage.
 * Each assistant message carries a `usage` field; we sum across the session.
 */
export async function aggregateSessionTokens(transcriptPath: string): Promise<TokenUsage> {
  const acc = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

  const rl = createInterface({
    input: createReadStream(transcriptPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as any
      const usage = entry?.message?.usage
      if (!usage) continue
      acc.inputTokens += usage.input_tokens ?? 0
      acc.outputTokens += usage.output_tokens ?? 0
      acc.cacheReadTokens += usage.cache_read_input_tokens ?? 0
      acc.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0
    } catch {
      // malformed line — skip
    }
  }

  return acc
}

export async function sessionTrack(opts: {
  transcriptPath?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  project?: string
  sessionId?: string
}): Promise<void> {
  let usage: TokenUsage

  if (opts.transcriptPath) {
    try {
      usage = await aggregateSessionTokens(opts.transcriptPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`Could not parse transcript: ${msg}`)
      return
    }
  } else {
    usage = {
      inputTokens: opts.inputTokens ?? 0,
      outputTokens: opts.outputTokens ?? 0,
      cacheReadTokens: opts.cacheReadTokens ?? 0,
      cacheWriteTokens: opts.cacheWriteTokens ?? 0,
    }
  }

  const project = opts.project ? path.basename(opts.project) : 'default'

  const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens

  track({
    event_type: 'session.tokens',
    project,
    payload: {
      sessionId: opts.sessionId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      totalTokens: total,
    },
  })

  await flush()

  logger.success(`✓ session.tokens tracked [${project}]`)
  logger.dim(`  in: ${usage.inputTokens.toLocaleString()}  out: ${usage.outputTokens.toLocaleString()}  cache-r: ${usage.cacheReadTokens.toLocaleString()}  cache-w: ${usage.cacheWriteTokens.toLocaleString()}  total: ${total.toLocaleString()}`)
}
