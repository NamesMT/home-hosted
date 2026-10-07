import type { ProcessLiveness } from '#src/providers/port'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { type } from 'arktype'
import { writeFileAtomic } from '#src/helpers/atomic'
import { runtimePath } from '#src/helpers/paths'
import { processLiveness } from '#src/providers/port'

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

/**
 * Re-exported from `providers/port.ts` so the two cannot drift on `EPERM` again.
 *
 * They already had: this copy treated a process owned by another user as alive (correct) while the
 * port one treated it as gone, which made a live nanny look absent. One definition, one answer.
 */
export { isProcessAlive } from '#src/providers/port'

/**
 * What became of the daemon this record describes: the verdict `run.json`'s pid cannot give on
 * its own. See `processLiveness` in `providers/port.ts` for why the pid is not an identity.
 */
export async function runtimeLiveness(runtime: Runtime): Promise<ProcessLiveness> {
  return await processLiveness(runtime.pid, runtime.startedAt)
}

/**
 * Is the daemon this record describes still the one running?
 *
 * `readRuntime()` answers "does a record exist", never "is the panel behind it alive" — and a pid
 * alone cannot answer that either. The OS reuses pids, and a zombie still answers signal 0, so a
 * bare `isProcessAlive(runtime.pid)` reported a stale `run.json` as a live panel: `up` refused with
 * "already running", `status` said "running, but not answering", and `down` signalled whatever
 * unrelated process had since inherited the pid.
 *
 * Every caller must read this one predicate, because a caller that re-derives it slightly differently
 * is how a `down` comes to signal a stranger.
 */
export async function runtimeIsAlive(runtime: Runtime): Promise<boolean> {
  return isLiveLiveness(await runtimeLiveness(runtime))
}

/**
 * Only `'live'` and `'unknown'` count as alive. `'unknown'` means the platform could not read a start
 * time, so the live pid is all there is — dismissing it would clear a record the running panel still
 * owns. `'recycled'` is emphatically **not** alive: the pid belongs to somebody else now.
 */
export function isLiveLiveness(liveness: ProcessLiveness): boolean {
  return liveness === 'live' || liveness === 'unknown'
}

/**
 * Is the record positively pointing at nothing at all — no process behind the pid?
 *
 * This is the **only** condition under which deleting `run.json` is safe, so it is deliberately
 * narrower than `!runtimeIsAlive`. The start-time check can be wrong in one direction: Linux derives
 * a process's birth epoch from `btime`, which the kernel computes from the wall clock
 * (`getboottime64`: "calls to settimeofday will affect the value returned"), so a forward clock step
 * — common when a laptop or a WSL host wakes from sleep — makes a *live* panel look recycled. Deleting
 * its record over that would orphan a running panel: still supervising servers, no longer stoppable by
 * `down`. A record that some process may still own is left alone and simply overwritten when a new
 * panel finishes booting.
 */
export async function runtimeIsGone(runtime: Runtime): Promise<boolean> {
  return await runtimeLiveness(runtime) === 'gone'
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
      // The `timeout` below is on the *request*, so it stops covering the call once the
      // headers are in. A socket that dies mid-body — the panel rebinding its listener is
      // the documented case — otherwise leaves this promise unsettled for ever, and
      // `down`/`start`/`stop` hang with it.
      response.once('aborted', () => resolve(null))
      response.once('error', () => resolve(null))
    })

    request.once('error', () => resolve(null))
    request.once('timeout', () => {
      request.destroy()
      resolve(null)
    })
    request.end()
  })
}
