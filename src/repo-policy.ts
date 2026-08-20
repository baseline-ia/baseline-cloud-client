import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RepoConfig {
  version?: number
  skills?: { disabled?: string[] }
}

export interface MergedPolicy {
  disabled: string[]
}

export function loadRepoConfig(workspaceDir: string): RepoConfig {
  const paths = [
    join(workspaceDir, '.baseline', 'config.json'),
    join(workspaceDir, '.baseline', 'config.local.json'),
  ]
  let merged: RepoConfig = {}
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as RepoConfig
      const extra = raw.skills?.disabled ?? []
      merged.skills ??= { disabled: [] }
      merged.skills.disabled = [...new Set([...(merged.skills.disabled ?? []), ...extra])]
    } catch { /* malformed — skip */ }
  }
  return merged
}

export function mergePolicy(
  cloudDisabled: string[],
  repoConfig: RepoConfig,
): MergedPolicy {
  const local = repoConfig.skills?.disabled ?? []
  return { disabled: [...new Set([...cloudDisabled, ...local])] }
}

export function generatePolicySteeringMd(policy: MergedPolicy, projectSlug: string): string {
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ')
  if (policy.disabled.length === 0) {
    return [
      '## baseline-cloud Repository Policy\n',
      `All skills are enabled for project \`${projectSlug}\`.\n`,
      `_Last synced: ${ts}_\n`,
    ].join('\n')
  }

  const list = policy.disabled.map(s => `- \`${s}\``).join('\n')
  return [
    '## baseline-cloud Repository Policy\n',
    'The following skills are **disabled** for this repository:\n',
    list + '\n',
    'When the user invokes a disabled skill, respond:',
    `> "⛔ The skill \`<name>\` is disabled for this project (\`${projectSlug}\`). To enable it, contact your admin or update \`.baseline/config.json\`."`,
    '\nDo not execute disabled skills under any circumstances.\n',
    `_Last synced: ${ts}_\n`,
  ].join('\n')
}

export function syncRepoPolicyForWorkspace(
  workspaceDir: string,
  cloudDisabled: string[],
  projectSlug: string,
): void {
  if (!workspaceDir || !existsSync(workspaceDir)) return
  const repoConfig = loadRepoConfig(workspaceDir)
  const policy = mergePolicy(cloudDisabled, repoConfig)
  const content = generatePolicySteeringMd(policy, projectSlug)

  const steeringDir = join(workspaceDir, '.kiro', 'steering')
  if (!existsSync(steeringDir)) {
    try { mkdirSync(steeringDir, { recursive: true }) } catch { return }
  }
  writeFileSync(join(steeringDir, 'baseline-repo-policy.md'), content, 'utf8')
}
