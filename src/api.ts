/**
 * Cloud addon: HTTP client.
 *
 * Thin typed wrapper around the global `fetch` for talking to a
 * baseline-cloud server. Every method returns a discriminated result
 * (status + parsed JSON) so callers can branch on HTTP outcomes without
 * try/catching on every call.
 *
 * Conventions:
 *  - All bodies are JSON.
 *  - Bearer auth is added by the caller (we don't auto-attach it,
 *    because some endpoints like /api/v1/auth/login and /api/v1/auth/signup
 *    are unauthenticated).
 *  - The Cloud addon never uses node:http, node:https, axios, or any
 *    other HTTP client — fetch is built into Node 18+ and is the only
 *    dependency we need.
 */

export interface JsonResponse<T = unknown> {
  status: number
  json: T | null
  ok: boolean
}

/**
 * POST a JSON body and parse the JSON response (if any).
 *
 * `body` is any JSON-serializable value. The function does NOT add
 * auth headers; the caller decides (some login endpoints are
 * unauthenticated).
 *
 * On a network error (DNS, connection refused, abort), the returned
 * promise REJECTS. Callers that need to swallow network errors should
 * wrap in try/catch. Callers that need to distinguish "server said 500"
 * from "could not reach server" should check `ok` (true for 2xx, false
 * otherwise) AND wrap in try/catch.
 */
export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<JsonResponse<T>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return parseResponse<T>(res)
}

/**
 * GET a URL and parse the JSON response.
 *
 * Like postJson, no auth headers are auto-attached. Network errors
 * reject; HTTP non-2xx returns ok=false.
 */
export async function getJson<T = unknown>(
  url: string,
  headers: Record<string, string> = {}
): Promise<JsonResponse<T>> {
  const res = await fetch(url, { method: 'GET', headers })
  return parseResponse<T>(res)
}

async function parseResponse<T>(res: Response): Promise<JsonResponse<T>> {
  let json: T | null = null
  try {
    json = (await res.json()) as T
  } catch {
    // Response had no JSON body (or malformed). json stays null.
  }
  return { status: res.status, json, ok: res.ok }
}
