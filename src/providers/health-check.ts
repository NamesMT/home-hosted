import type { HttpCheckConfig } from '#src/shared/contracts'
import { probePort } from '#src/providers/port'

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

export interface HttpProbeOptions extends Pick<HttpCheckConfig, 'path' | 'method' | 'expectBody' | 'expectStatusBelow'> {
  /** `null` counts as "not set", so a value saved by the UI can be cleared again. */
  expectStatus?: number | null
  timeoutMs: number
}

/**
 * Fetches the configured path and asserts the response, so "listening" is not
 * mistaken for "working".
 */
export async function probeHttp(host: string, port: number, options: HttpProbeOptions): Promise<HealthProbeResult> {
  const url = `http://${host}:${port}${options.path.startsWith('/') ? options.path : `/${options.path}`}`
  const started = Date.now()

  try {
    const response = await fetch(url, {
      method: options.method,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    const ms = Date.now() - started

    const expected = options.expectStatus ?? null
    if (expected !== null && response.status !== expected) {
      return { healthy: false, ms, detail: `expected status ${expected}, got ${response.status}` }
    }
    if (expected === null && response.status >= options.expectStatusBelow) {
      return { healthy: false, ms, detail: `status ${response.status} is >= ${options.expectStatusBelow}` }
    }

    if (options.expectBody.length > 0 && options.method !== 'HEAD') {
      const body = await response.text()
      if (!body.includes(options.expectBody)) {
        return { healthy: false, ms, detail: `body does not contain ${JSON.stringify(options.expectBody)}` }
      }
    }

    return { healthy: true, ms, detail: `HTTP ${response.status}` }
  }
  catch (error) {
    const ms = Date.now() - started
    const reason = error instanceof Error ? error.message : String(error)
    return { healthy: false, ms, detail: `request failed: ${reason}` }
  }
}

export async function probeHealth(options: {
  mode: 'port' | 'http'
  hosts: string[]
  port: number
  timeoutMs: number
  http: Pick<HttpCheckConfig, 'path' | 'method' | 'expectBody' | 'expectStatusBelow'> & { expectStatus?: number | null }
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
