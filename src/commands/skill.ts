import path from 'node:path'
import { track, flush } from '../telemetry'
import { logger } from '../logger'

export function skillTrack(opts: {
  name: string
  project?: string
  durationMs?: number
}): void {
  const project = opts.project ? path.basename(opts.project) : 'default'

  track({
    event_type: 'skill.used',
    project,
    payload: {
      skillName: opts.name,
      ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
    },
  })

  void flush()
  logger.success(`✓ skill.used tracked: ${opts.name} [${project}]`)
}
