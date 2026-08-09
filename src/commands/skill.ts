import { track, flush } from '../telemetry'
import { logger } from '../logger'
import { resolveProjectIdentity } from '../project-identity'

export async function skillTrack(opts: {
  name: string
  project?: string
  durationMs?: number
}): Promise<void> {
  const project = resolveProjectIdentity(opts.project)

  track({
    event_type: 'skill.used',
    project,
    payload: {
      skillName: opts.name,
      ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
    },
  })

  await flush()
  logger.success(`✓ skill.used tracked: ${opts.name} [${project}]`)
}
