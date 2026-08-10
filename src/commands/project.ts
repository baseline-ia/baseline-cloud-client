import { loadConfig } from '../auth'
import { postJson } from '../api'
import { logger } from '../logger'
import { resolveProjectIdentity } from '../project-identity'
import { syncCorporateSkills } from './skills-corporate'

interface ProjectEnrollResponse {
  ok?: boolean
  created?: boolean
  project?: { slug: string; name: string; enabled: boolean }
  error_class?: string
  error_code?: string
  error?: string
  assigned_skills?: string[]
}

export interface EnrollProjectOpts {
  slug?: string
  name?: string
  path?: string
}

export async function enrollProject(opts: EnrollProjectOpts = {}): Promise<void> {
  const config = loadConfig()
  if (!config) {
    throw new Error('Cloud is not configured. Run `baseline-cloud cloud login` first.')
  }

  const project = resolveProjectIdentity(opts.slug ?? opts.path)
  const name = opts.name?.trim() || project
  const response = await postJson<ProjectEnrollResponse>(
    `${config.server_url}/api/v1/projects/enroll`,
    { slug: project, name },
    {
      Authorization: `Bearer ${config.token}`,
      'Idempotency-Key': `project-enroll:${project}`,
    },
  )

  if (response.status !== 200 && response.status !== 201) {
    const detail = response.json?.error_code ?? response.json?.error ?? `HTTP ${response.status}`
    throw new Error(`Project enrollment failed: ${detail}`)
  }

  logger.success(
    response.json?.created === false
      ? `Project already enrolled: ${response.json.project?.slug ?? project}`
      : `Project enrolled: ${response.json?.project?.slug ?? project}`,
  )
  if (response.json?.assigned_skills && response.json.assigned_skills.length > 0) {
    await syncCorporateSkills({ project })
  }
}
