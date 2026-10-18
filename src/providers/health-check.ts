import type { HttpCheckConfig } from '#src/shared/contracts'
import http from 'node:http'
import https from 'node:https'
import { probePort } from '#src/providers/port'
import { errorMessage } from '#src/shared/error-message'

export interface HealthProbeResult {
  healthy: boolean
  ms: number
  detail: string
}

/** TCP connect timing, used for the default `port` mode and readiness. */
export async function probeTcp(host: string, port: number, timeoutMs: number): Promise<HealthProbeResult> {
  const started = Date.now()
  const accepting = await probePort(host, port, timeoutMs)
  const ms = Date.now() - started
  return { healthy: accepting, ms, detail: accepting ? 'port accepted a connection' : 'port did not accept a connection' }
}

export interface HttpProbeOptions extends Pick<HttpCheckConfig, 'scheme' | 'allowInvalidCert' | 'path' | 'method' | 'expectBody' | 'expectStatusBelow'> {
  /** `null` counts as "not set", so a value saved by the UI can be cleared again. */
  expectStatus?: number | null
  timeoutMs: number
}

/**
 * One request/response, capped at `timeoutMs`.
 *
 * Node's `fetch` cannot be told to accept a certificate it does not trust, which is the normal
 * case for a backend on a home network: its own self-signed pair, or one from the engine's local
 * CA. So this speaks http/https directly, the same way `helpers/daemon.ts` reaches a panel with an
 * uploaded pair. A `HEAD` gets no body, which the caller already accounts for.
 */
function request(
  url: URL,
  method: 'GET' | 'HEAD',
  allowInvalidCert: boolean,
  timeoutMs: number,
): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:'
    const req = (secure ? https : http).request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      // Local and explicit: the operator asked the panel to trust this backend.
      ...(secure && allowInvalidCert ? { rejectUnauthorized: false } : {}),
      // A redirect is answered, not followed: the status itself is what the check asserts.
      timeout: timeoutMs,
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
      })
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body }))
      response.once('error', reject)
    })

    req.once('error', reject)
    // `timeout` only covers the socket until the response headers arrive, so a server that
    // accepts and then stalls would leave this promise unsettled forever and the probe would
    // hang the supervisor's tick.
    req.once('timeout', () => {
      req.destroy()
      reject(new Error(`no response within ${timeoutMs}ms`))
    })
    req.end()
  })
}

/**
 * Fetches the configured path and asserts the response, so "listening" is not
 * mistaken for "working".
 */
export async function probeHttp(host: string, port: number, options: HttpProbeOptions): Promise<HealthProbeResult> {
  const url = new URL(`${options.scheme}://${host}:${port}${options.path.startsWith('/') ? options.path : `/${options.path}`}`)
  const started = Date.now()

  try {
    const response = await request(url, options.method, options.allowInvalidCert, options.timeoutMs)
    const ms = Date.now() - started

    const expected = options.expectStatus ?? null
    if (expected !== null && response.status !== expected) {
      return { healthy: false, ms, detail: `expected status ${expected}, got ${response.status}` }
    }
    if (expected === null && response.status >= options.expectStatusBelow) {
      return { healthy: false, ms, detail: `status ${response.status} is >= ${options.expectStatusBelow}` }
    }

    // A `HEAD` cannot carry a body, so a configured body requirement is skipped — said in the detail
    // rather than passed over in silence. The card and the log read this line, and `HTTP 200` looked
    // identical whether or not the assertion ran; the config parser also warns at load.
    const bodySkipped = options.expectBody.length > 0 && options.method === 'HEAD'
    if (options.expectBody.length > 0 && !bodySkipped) {
      if (!response.body.includes(options.expectBody)) {
        return { healthy: false, ms, detail: `body does not contain ${JSON.stringify(options.expectBody)}` }
      }
    }

    if (bodySkipped)
      return { healthy: true, ms, detail: `HTTP ${response.status} (a HEAD carries no body, so the body check was skipped)` }

    return { healthy: true, ms, detail: `HTTP ${response.status}` }
  }
  catch (error) {
    const ms = Date.now() - started
    const reason = errorMessage(error)
    return { healthy: false, ms, detail: `request failed: ${reason}` }
  }
}

export async function probeHealth(options: {
  mode: 'port' | 'http'
  hosts: string[]
  port: number
  timeoutMs: number
  http: Pick<HttpCheckConfig, 'scheme' | 'allowInvalidCert' | 'path' | 'method' | 'expectBody' | 'expectStatusBelow'> & { expectStatus?: number | null }
}): Promise<HealthProbeResult> {
  let last: HealthProbeResult = { healthy: false, ms: 0, detail: 'not probed' }

  // Try each candidate host in order (loopback first), so a server bound to one
  // specific address is still probed somewhere it actually listens.
  for (const host of options.hosts) {
    const result = options.mode === 'http'
      ? await probeHttp(host, options.port, { ...options.http, timeoutMs: options.timeoutMs })
      : await probeTcp(host, options.port, options.timeoutMs)
    if (result.healthy)
      return result
    last = result
  }

  return last
}
