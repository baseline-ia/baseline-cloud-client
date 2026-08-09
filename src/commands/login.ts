/**
 * Cloud addon command: `baseline login`.
 *
 * Authenticate against a self-hosted baseline-cloud instance.
 *
 * Interactive flow:
 *   1. Prompt for server URL (default: http://localhost:3000)
 *   2. Prompt for username + password (with hidden input for the password)
 *   3. POST /v1/auth/login
 *   4. If 401 (no such user), POST /v1/auth/signup to register
 *   5. Save the returned token to ~/.baseline/cloud.json (mode 0600)
 *   6. Fire `cli.login` event
 *   7. Offer to install the post-commit hook (only inside a git repo
 *      and only if not already installed)
 *
 * Non-interactive (CI):
 *   BASELINE_CLOUD_URL=... BASELINE_CLOUD_USERNAME=... BASELINE_CLOUD_PASSWORD=... baseline login --no-input
 *
 * Pre-existing-token flow:
 *   baseline login --server <url> --token <raw-token>
 *   For admins who issued a token from the dashboard and want to give
 *   it directly to a machine (no password needed).
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout, exit } from 'node:process'
import { logger } from '../logger'
import { saveConfig } from '../auth'
import { postJson } from '../api'
import { track, flush, envContext, detectTools, registerExitFlush } from '../telemetry'
import { isInsideGitRepo, installHook, isHookInstalled } from '../git-hooks'

interface LoginResponse {
  user: { id: string; username: string; email: string; role: 'admin' | 'member' }
  token?: { id: string; raw: string; prefix: string; name: string }
  warning?: string
  error?: string
}

interface LoginListResponse {
  user: { id: string; username: string; email: string; role: 'admin' | 'member' }
  tokens: Array<{
    id: string
    prefix: string
    name: string
    createdAt: string
    lastUsedAt: string | null
    revokedAt: string | null
  }>
  token_issue?: string
  error?: string
}

async function readRl() {
  return createInterface({ input: stdin, output: stdout })
}

export interface LoginOpts {
  noInput?: boolean
  serverUrl?: string
  username?: string
  password?: string
  skipHookPrompt?: boolean
}

/**
 * The main login flow. Idempotent: re-running with the same
 * credentials overwrites the saved config.
 */
export async function login(opts: LoginOpts = {}): Promise<void> {
  registerExitFlush()
  const noInput = opts.noInput ?? false
  let serverUrl = opts.serverUrl ?? process.env.BASELINE_CLOUD_URL
  let username = opts.username ?? process.env.BASELINE_CLOUD_USERNAME
  let password = opts.password ?? process.env.BASELINE_CLOUD_PASSWORD

  if (noInput) {
    if (!serverUrl || !username || !password) {
      logger.error(
        'Non-interactive login requires BASELINE_CLOUD_URL, BASELINE_CLOUD_USERNAME, BASELINE_CLOUD_PASSWORD'
      )
      exit(1)
    }
  } else {
    const rl = await readRl()
    try {
      const def = serverUrl ?? 'http://localhost:3000'
      const ans = (await rl.question(`Server URL [${def}]: `)).trim()
      serverUrl = (ans || def).replace(/\/+$/, '')
      if (!username || !password) {
        const u = (await rl.question('Username: ')).trim()
        const p = (await rl.question('Password: ')).trim()
        username = u
        password = p
      }
    } finally {
      rl.close()
    }
  }

  if (!serverUrl || !username || !password) {
    logger.error('Missing server URL, username, or password')
    exit(1)
  }

  // Try login first.
  let raw: string | null = null
  let user: LoginResponse['user'] | null = null
  let warning: string | undefined

  const loginRes = await postJson<LoginListResponse>(`${serverUrl}/api/v1/auth/login`, {
    username,
    password,
  })
  if (loginRes.status === 200) {
    const body = loginRes.json as LoginListResponse
    user = body.user
    // Note: a successful login does not return a fresh token — the
    // server expects the user to either already have a token or to
    // ask an admin to issue one. We surface this clearly below.
    raw = null
  } else if (loginRes.status === 401) {
    // No such user — try to sign them up.
    const signupRes = await postJson<LoginResponse>(`${serverUrl}/api/v1/auth/signup`, {
      username,
      password,
    })
    if (signupRes.status === 201) {
      const body = signupRes.json as LoginResponse
      user = body.user
      raw = body.token?.raw ?? null
      warning = body.warning
    } else {
      logger.error(`Signup failed (${signupRes.status}): ${JSON.stringify(signupRes.json)}`)
      exit(1)
    }
  } else {
    logger.error(`Login failed (${loginRes.status}): ${JSON.stringify(loginRes.json)}`)
    exit(1)
  }

  if (!user) {
    logger.error('Authentication failed: no user returned')
    exit(1)
  }

  if (!raw) {
    logger.warn(`✓ Logged in as ${user.username}, but the server did not return a fresh token.`)
    logger.warn('To use the CLI, ask your admin to issue a token from the dashboard:')
    logger.warn('  Dashboard → Admin → Tokens → Issue → copy the raw token')
    logger.warn('Then run: baseline login --token <raw-token> --server <url>')
    exit(0)
  }

  saveConfig({ server_url: serverUrl, token: raw })
  logger.success(`✓ Logged in as ${user.username} (${user.role})`)
  logger.info(`  Server: ${serverUrl}`)
  logger.info(`  Token prefix: ${raw.split('.')[0]}`)
  logger.info(`  Config saved to ~/.baseline/cloud.json`)
  if (warning) logger.warn(warning)

  // Fire cli.login event
  track({
    event_type: 'cli.login',
    project: 'default',
    payload: { serverUrl, via: 'interactive' },
  })

  // Fire cli.install (first-time metrics) with current env context
  track({
    event_type: 'cli.install',
    project: 'default',
    payload: { ...envContext(), toolsDetected: detectTools(), viaLogin: true },
  })

  // Offer to install the post-commit hook (only if we're inside a git
  // repo and not already installed).
  if (!opts.skipHookPrompt && isInsideGitRepo() && !isHookInstalled()) {
    const rl = await readRl()
    try {
      const ans = (
        await rl.question('Install post-commit git hook for automatic commit tracking? [Y/n] ')
      )
        .trim()
        .toLowerCase()
      if (ans === '' || ans === 'y' || ans === 'yes') {
        const r = installHook()
        if (r.installed) {
          logger.success(`✓ ${r.message}`)
        }
      }
    } finally {
      rl.close()
    }
  }

  await flush()
}
