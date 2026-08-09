/**
 * Cloud addon command: `baseline-cloud cloud login`.
 *
 * Authenticate against a self-hosted baseline-cloud instance.
 *
 * Interactive flow:
 *   1. Prompt for server URL (default: http://localhost:3000)
 *   2. Choose username/password or an existing API token
 *   3. Authenticate with the selected method
 *   4. Save the token to ~/.baseline/cloud.json (mode 0600)
 *   5. Fire `cli.login` event
 *   6. Offer to install the post-commit hook (only inside a git repo
 *      and only if not already installed)
 *
 * Non-interactive (CI):
 *   BASELINE_CLOUD_URL=... BASELINE_CLOUD_USERNAME=... BASELINE_CLOUD_PASSWORD=... baseline-cloud cloud login --no-input
 *
 * Pre-existing-token flow:
 *   baseline-cloud cloud login --server <url> --token <raw-token>
 *   For admins who issued a token from the dashboard and want to give
 *   it directly to a machine (no password needed).
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout, exit } from 'node:process'
import { logger } from '../logger'
import { saveConfig, tokenPrefix } from '../auth'
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

interface TokenResponse {
  token?: LoginResponse['token']
  token_issue?: string
}

async function readRl() {
  return createInterface({ input: stdin, output: stdout })
}

interface SecretInput extends NodeJS.ReadableStream {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode?: (mode: boolean) => SecretInput
}

interface SecretOutput {
  isTTY?: boolean
  write: (chunk: string) => boolean
}

/** Read a secret without echoing it when both streams are interactive TTYs. */
export function readSecret(
  prompt: string,
  rl: Awaited<ReturnType<typeof readRl>>,
  input: SecretInput = stdin,
  output: SecretOutput = stdout
): Promise<string> {
  if (!input.isTTY || !output.isTTY || !input.setRawMode) {
    return rl.question(prompt)
  }

  return new Promise((resolve, reject) => {
    let value = ''
    const wasRaw = input.isRaw ?? false
    let cleanedUp = false

    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      input.off('data', onData)
      input.off('error', onError)
      try {
        input.setRawMode?.(wasRaw)
      } catch {
        // The terminal may already be unavailable while handling an error.
      }
      try {
        input.resume?.()
      } catch {
        // Cleanup must not mask the original input error.
      }
    }

    const finish = (error?: Error) => {
      cleanup()
      output.write('\n')
      if (error) reject(error)
      else resolve(value)
    }

    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString()) {
        if (character === '\u0003') {
          finish(new Error('Input cancelled'))
          return
        }
        if (character === '\u0004') {
          finish(new Error('Input ended'))
          return
        }
        if (character === '\r' || character === '\n') {
          finish()
          return
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1)
          continue
        }
        if (character === '\u0015') {
          value = ''
          continue
        }
        value += character
      }
    }

    const onError = (error: Error) => finish(error)

    output.write(prompt)
    input.on('data', onData)
    input.once('error', onError)
    try {
      input.setRawMode?.(true)
      input.resume?.()
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function validServerUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export interface LoginOpts {
  noInput?: boolean
  serverUrl?: string
  token?: string
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

  // Direct token path: --server + --token skips the password flow entirely.
  if (opts.token) {
    const serverUrl = (opts.serverUrl ?? process.env.BASELINE_CLOUD_URL ?? '').replace(/\/+$/, '')
    if (!serverUrl) {
      logger.error('--token requires --server <url> or BASELINE_CLOUD_URL')
      exit(1)
    }
    saveConfig({ server_url: serverUrl, token: opts.token })
    logger.success(`✓ Token saved`)
    logger.info(`  Server: ${serverUrl}`)
    logger.info(`  Token prefix: ${tokenPrefix(opts.token)}`)
    logger.info(`  Config saved to ~/.baseline/cloud.json`)
    track({ event_type: 'cli.login', project: 'default', payload: { serverUrl, via: 'token' } })
    await flush()
    return
  }

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
      if (!username && !password) {
        let method = ''
        while (method !== 'a' && method !== 'b') {
          method = (await rl.question('Authentication method: (a) username/password or (b) API token: '))
            .trim()
            .toLowerCase()
          if (method !== 'a' && method !== 'b') {
            logger.warn('Choose a or b.')
          }
        }

        if (method === 'b') {
          const def = serverUrl ?? 'http://localhost:3000'
          const ans = (await rl.question(`Server URL [${def}]: `)).trim()
          serverUrl = (ans || def).replace(/\/+$/, '')
          const token = (await readSecret('Existing API token: ', rl)).trim()
          if (!serverUrl || !validServerUrl(serverUrl) || !token) {
            logger.error('A valid server URL and a non-empty API token are required.')
            exit(1)
          }
          saveConfig({ server_url: serverUrl, token })
          logger.success('✓ Token saved')
          logger.info(`  Server: ${serverUrl}`)
          logger.info(`  Token prefix: ${tokenPrefix(token)}`)
          logger.info('  Config saved to ~/.baseline/cloud.json')
          track({ event_type: 'cli.login', project: 'default', payload: { serverUrl, via: 'token' } })
          await flush()
          return
        }
      }

      const def = serverUrl ?? 'http://localhost:3000'
      const ans = (await rl.question(`Server URL [${def}]: `)).trim()
      serverUrl = (ans || def).replace(/\/+$/, '')
      if (!username || !password) {
        username = (await rl.question('Username: ')).trim()
        password = (await readSecret('Password: ', rl)).trim()
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
  let tokenIssue: string | undefined

  const loginRes = await postJson<LoginListResponse>(`${serverUrl}/api/v1/auth/login`, {
    username,
    password,
  })
  if (loginRes.status === 200) {
    const body = loginRes.json as LoginListResponse
    user = body.user
    try {
      const tokenRes = await postJson<TokenResponse>(`${serverUrl}/api/v1/auth/token`, {
        name: username,
        password,
      })
      tokenIssue = tokenRes.json?.token_issue
      if (tokenRes.status >= 200 && tokenRes.status < 300) {
        raw = tokenRes.json?.token?.raw ?? null
      }
    } catch {
      // Preserve the successful credential login result, but do not claim
      // success with a saved token when issuance was unreachable.
    }
  } else if (loginRes.status === 401) {
    const body401 = loginRes.json as { reason?: string } | null
    if (body401?.reason !== 'not_found') {
      // User exists but password is wrong (or account disabled).
      logger.error('Invalid username or password.')
      exit(1)
    }
    // User does not exist — auto-register.
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
    const loginBody = loginRes.json as LoginListResponse | null
    const hint =
      tokenIssue ??
      loginBody?.token_issue ??
      'Ask your admin to issue a token from Dashboard → Admin → Tokens'
    logger.warn(`✓ Logged in as ${user.username}, but no bearer token is available.`)
    logger.warn(hint)
    logger.warn('Then run: baseline-cloud cloud login --server <url> --token <raw-token>')
    exit(0)
  }

  saveConfig({ server_url: serverUrl, token: raw })
  logger.success(`✓ Logged in as ${user.username} (${user.role})`)
  logger.info(`  Server: ${serverUrl}`)
  logger.info(`  Token prefix: ${tokenPrefix(raw)}`)
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
