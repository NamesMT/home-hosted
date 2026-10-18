import type { HttpCheckConfig } from '#src/shared/contracts'
import { Buffer } from 'node:buffer'
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
 * How much of a response body a probe will read.
 *
 * A probe asserts `expectStatus` and a substring; neither needs the whole document. The cap is
 * also a safety property, not just an allocation one: `http.request`'s `timeout` is an **idle**
 * timeout, so an endpoint that keeps streaming never trips it, and an unbounded `+=` on the
 * chunks grew until V8 threw `RangeError: Invalid string length` **inside the data handler** —
 * which kills the panel rather than failing one probe. Measured against a stream that writes
 * 64 KB every millisecond.
 */
const MAX_BODY_BYTES = 1_000_000

/**
 * One request/response, capped at `timeoutMs` and `MAX_BODY_BYTES`.
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
): Promise<{ status: number, body: string, truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:'
    // `req` is assigned below; the deadline and the settle wrappers close over it, which is why
    // the request is created before any of them can run.
    let req: http.ClientRequest
    // Every path settles through these, so the deadline is always cleared and a second
    // settlement — a `timeout` after the deadline fired, a `destroy()` error after the cap —
    // is dropped instead of escaping as an unhandled rejection.
    let settled = false
    let deadline: NodeJS.Timeout
    const finish = (value: { status: number, body: string, truncated: boolean }): void => {
      if (settled)
        return
      settled = true
      clearTimeout(deadline)
      resolve(value)
    }
    const fail = (error: unknown): void => {
      if (settled)
        return
      settled = true
      clearTimeout(deadline)
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    /**
     * The whole exchange, not just the socket.
     *
     * `timeout` on the request is an **idle** timeout, so a server dripping one byte every half
     * second keeps resetting it and the probe never returns — which hangs the supervisor's tick,
     * since the probe is awaited. The old `fetch` path had `AbortSignal.timeout`, an absolute
     * cap; this restores that guarantee.
     */
    deadline = setTimeout(() => {
      fail(new Error(`no complete response within ${timeoutMs}ms`))
      req.destroy()
    }, timeoutMs)
    deadline.unref()

    req = (secure ? https : http).request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      // Local and explicit: the operator asked the panel to trust this backend.
      ...(secure && allowInvalidCert ? { rejectUnauthorized: false } : {}),
      timeout: timeoutMs,
    }, (response) => {
      let body = ''
      let bytes = 0
      let truncated = false
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        if (truncated)
          return
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_BODY_BYTES) {
          // Stop reading rather than accumulate: the assertion runs against this prefix, and
          // the detail says so instead of reporting a silent pass.
          truncated = true
          body += chunk.slice(0, Math.max(0, MAX_BODY_BYTES - (bytes - Buffer.byteLength(chunk))))
          response.destroy()
          finish({ status: response.statusCode ?? 0, body, truncated })
          return
        }
        body += chunk
      })
      response.once('end', () => {
        if (!truncated)
          finish({ status: response.statusCode ?? 0, body, truncated })
      })
      response.once('error', (error) => {
        // A `destroy()` after the cap surfaces here; the resolution above already happened.
        if (!truncated)
          fail(error)
      })
    })

    // The deadline above outlives these handlers, so a late error after it fired is ignored by
    // the already-settled promise rather than escaping as an unhandled rejection.
    req.once('error', error => fail(error))
    // Catches a socket that goes idle before the headers arrive, sooner than the deadline.
    req.once('timeout', () => {
      fail(new Error(`no response within ${timeoutMs}ms`))
      req.destroy()
    })
    req.end()
  })
}

/**
 * Fetches the configured path and asserts the response, so "listening" is not
 * mistaken for "working".
 */
export async function probeHttp(host: string, port: number, options: HttpProbeOptions): Promise<HealthProbeResult> {
  const started = Date.now()

  try {
    // Inside the `try`: a host the URL parser refuses must be a failed probe, not a throw out
    // of the probe and into the supervisor's tick.
    const url = new URL(`${options.scheme}://${host}:${port}${options.path.startsWith('/') ? options.path : `/${options.path}`}`)
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
        const scope = response.truncated ? ` (only the first ${MAX_BODY_BYTES} bytes were read)` : ''
        return { healthy: false, ms, detail: `body does not contain ${JSON.stringify(options.expectBody)}${scope}` }
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
