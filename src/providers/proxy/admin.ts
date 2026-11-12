import type { ProxyAdminTransport } from '#src/providers/proxy/types'
import { Buffer } from 'node:buffer'
import http from 'node:http'

const ADMIN_TIMEOUT_MS = 5000

/**
 * One request to a running engine's admin API, over its unix socket or loopback TCP (with the
 * `Origin` the engine enforces there). Settles exactly once, and a truncated answer is a failure.
 */
export function adminRequest(
  admin: ProxyAdminTransport,
  method: string,
  urlPath: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number, body: string }> {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
  const headers: Record<string, string | number> = { ...extraHeaders }
  if (payload !== null) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = payload.length
  }
  if (admin.kind === 'tcp')
    headers.origin = admin.origin

  return new Promise((resolve, reject) => {
    // The engine can answer with headers and half a body and then destroy the
    // socket. Only the first outcome wins, so a late 'error' after 'end' is noise.
    let settled = false
    const succeed = (value: { status: number, body: string }): void => {
      if (settled)
        return
      settled = true
      resolve(value)
    }
    const fail = (error: unknown): void => {
      if (settled)
        return
      settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    const request = http.request({
      ...(admin.kind === 'unix' ? { socketPath: admin.path } : { host: admin.host, port: admin.port }),
      method,
      path: urlPath,
      headers,
      timeout: ADMIN_TIMEOUT_MS,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => succeed({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      // A truncated response is not an answer: without these the promise never
      // settles, and everything awaiting it — apply(), start()'s waitReady() and
      // the panel tick's sync() — waits for good.
      response.on('error', fail)
      response.on('aborted', () => fail(new Error('the engine closed the connection before it answered')))
    })
    request.on('timeout', () => request.destroy(new Error('the engine did not answer in time')))
    request.on('error', fail)
    if (payload !== null)
      request.write(payload)
    request.end()
  })
}

/** Caddy answers with `{"error": "..."}`; that sentence is the useful part. */
export function engineMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    return typeof parsed.error === 'string' && parsed.error.length > 0 ? parsed.error : null
  }
  catch {
    return body.trim().length > 0 ? body.trim().slice(0, 400) : null
  }
}
