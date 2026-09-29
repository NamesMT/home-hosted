import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import process from 'node:process'
import { type } from 'arktype'
import { writeFileAtomic } from '#src/helpers/atomic'
import { runtimePath } from '#src/helpers/paths'

/**
 * `run.json` is how `status`/`down` find the live control plane and how they are
 * allowed to stop it without a password: the file is mode 0600, and the token in
 * it is what `POST /_hh/shutdown` checks.
 */
export const runtimeSchema = type({
  version: 'string',
  pid: 'number.integer >= 1',
  /** The address that was actually bound, for humans. */
  url: 'string',
  /** Always a reachable loopback address, for probes (`lan` binds to 0.0.0.0). */
  probeUrl: 'string',
  protocol: 'string',
  port: '1 <= number.integer <= 65535',
  bindHost: 'string',
  startedAt: 'number',
  projectDir: 'string',
  dataRoot: 'string',
  configPath: 'string',
  logFile: 'string',
  token: 'string >= 1',
}).onUndeclaredKey('reject')
export type Runtime = typeof runtimeSchema.infer

export function readRuntime(): Runtime | null {
  try {
    const parsed = runtimeSchema(JSON.parse(fs.readFileSync(runtimePath, 'utf8')))
    return parsed instanceof type.errors ? null : parsed
  }
  catch {
    return null
  }
}

export function writeRuntime(runtime: Runtime): void {
  writeFileAtomic(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 })
}

export function clearRuntime(): void {
  fs.rmSync(runtimePath, { force: true })
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Signal 0 only probes the pid; `EPERM` still means the process is there. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface RuntimeProbe {
  /** The panel answered on its own port — stronger than "the pid exists". */
  reachable: boolean
  /** It answered, but reports a crashed autostart server (`/healthz` is 503). */
  degraded: boolean
}

/** A degraded panel is still answering: a 503 must not read as "not running". */
export async function probeRuntime(runtime: Runtime, timeoutMs = 2500): Promise<RuntimeProbe> {
  const answer = await localCall(runtime, '/healthz', 'GET', undefined, timeoutMs)
  return { reachable: answer !== null, degraded: answer?.status === 503 }
}

/**
 * Asks the daemon to stop through its own endpoint, so supervised servers are
 * shut down cleanly on every platform (a bare signal is not graceful on Windows).
 */
export async function requestShutdown(runtime: Runtime, timeoutMs = 4000): Promise<boolean> {
  const answer = await localCall(runtime, '/_hh/shutdown', 'POST', runtime.token, timeoutMs)
  return answer !== null && answer.status >= 200 && answer.status < 300
}

/** A `/_hh` answer: the status, plus the body when it was JSON. */
export interface ControlAnswer {
  status: number
  body: unknown
}

/**
 * Drives a supervised server from this machine (`home-hosted start`/`stop`). The
 * token comes from run.json, so it needs no session, no password and no API token —
 * only the owner of that 0600 file, talking over loopback.
 *
 * The wait is generous on purpose: a start may have to run a bootstrap, which has a
 * 120s default timeout of its own. Past this it is a wedged panel, not a slow one.
 */
export async function requestControl(runtime: Runtime, path: string, timeoutMs = 150000): Promise<ControlAnswer | null> {
  const answer = await localCall(runtime, path, 'POST', runtime.token, timeoutMs)
  if (answer === null)
    return null

  let body: unknown = null
  try {
    body = JSON.parse(answer.body)
  }
  catch {
    // Not JSON: an empty body or a proxy's error page. The status still means something.
  }
  return { status: answer.status, body }
}

/**
 * Talks to the panel over loopback. Node's `fetch` cannot be told to accept the
 * self-signed certificate an uploaded TLS pair usually is, which would break
 * `status`, the graceful `down` and the local start/stop — so this speaks
 * http/https directly.
 */
function localCall(runtime: Runtime, path: string, method: 'GET' | 'POST', token: string | undefined, timeoutMs: number): Promise<{ status: number, body: string } | null> {
  return new Promise((resolve) => {
    const url = new URL(`${runtime.probeUrl}${path}`)
    const secure = url.protocol === 'https:'
    const request = (secure ? https : http).request({
      hostname: url.hostname,
      port: url.port,
      // The query travels too: a workspace-scoped local call names its workspace there.
      path: `${url.pathname}${url.search}`,
      method,
      // Only ever pointed at our own listener on this machine.
      ...(secure ? { rejectUnauthorized: false } : {}),
      headers: token === undefined ? {} : { 'x-home-hosted-token': token },
      timeout: timeoutMs,
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
      })
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })

    request.once('error', () => resolve(null))
    request.once('timeout', () => {
      request.destroy()
      resolve(null)
    })
    request.end()
  })
}
