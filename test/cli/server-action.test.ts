import type { ChildProcess } from 'node:child_process'
import type net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { isProcessAlive } from '#src/providers/port'

/**
 * `start`/`stop` against a real listener and a real run.json: the CLI has to read the
 * token out of the file, speak `/_hh`, and turn the panel's answer into one line —
 * including the panel that is too old to know the route at all.
 *
 * `spawn`, never `spawnSync`: the panel is a listener in *this* process, and a
 * synchronous wait would freeze the event loop that has to answer it.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-server-cmd-'))

function runCli(args: string[]): Promise<{ status: number | null, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), ...args], {
      cwd: root,
      env: { ...process.env, HHOSTED_HOME: home, HHOSTED_PROJECT: home },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('close', status => resolve({ status, stdout, stderr }))
  })
}

const servers: http.Server[] = []
/** Stranger processes spawned as stand-ins for a recycled pid; killed after each test. */
const children: ChildProcess[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && isProcessAlive(child.pid))
      child.kill('SIGKILL')
  }
  // Dropped per test, not only at the end: a run.json naming this process is what `down`
  // would signal, and leaving one behind made a later test shoot its own worker.
  await fs.promises.rm(path.join(home, '.hh', 'run.json'), { force: true })
})

afterAll(async () => {
  await fs.promises.rm(home, { recursive: true, force: true })
})

interface Panel {
  url: string
  seen: { path?: string, token?: string }
}

/** A throwaway panel that answers one status and body, and records what it was asked. */
async function panel(status: number, body: string, contentType = 'application/json'): Promise<Panel> {
  const seen: Panel['seen'] = {}
  const server = http.createServer((req, res) => {
    seen.path = req.url
    seen.token = req.headers['x-home-hosted-token'] as string | undefined
    res.statusCode = status
    res.setHeader('content-type', contentType)
    res.end(body)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as net.AddressInfo
  return { url: `http://127.0.0.1:${address.port}`, seen }
}

/** A run.json the CLI accepts, pointing at `url` and claiming `version`. */
function writeRuntime(url: string, version = '0.9.9', overrides: { pid?: number, startedAt?: number } = {}): void {
  const address = new URL(url)
  const file = path.join(home, '.hh', 'run.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({
    version,
    // This process is alive, which is what `isProcessAlive` asks about.
    pid: overrides.pid ?? process.pid,
    url,
    probeUrl: url,
    protocol: 'http',
    port: Number(address.port),
    bindHost: '127.0.0.1',
    startedAt: overrides.startedAt ?? Date.now(),
    projectDir: home,
    dataRoot: home,
    configPath: path.join(home, '.hh', 'default', 'servers.config.json'),
    logFile: path.join(home, '.hh', '.logs', 'home-hosted.log'),
    token: 'local-token',
  }, null, 2)}\n`)
}

/** A pid that is alive but whose process started long after the record was written. */
async function recycledPid(): Promise<{ pid: number, startedAt: number }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  children.push(child)
  if (child.pid === undefined)
    throw new Error('could not spawn the stranger')
  // The record claims to have been written an hour ago, so a pid born just now cannot be it.
  return { pid: child.pid, startedAt: Date.now() - 3600_000 }
}

/**
 * A free port in the dev range (6xxx), never handed out twice to this file.
 *
 * The CLI's port preflight runs *before* its config guard, so a busy 3999 turns a real assertion red
 * for a reason that names nothing. 6xxx is the documented range for dev and test instances.
 */
const taken = new Set<number>()
function freeDevPort(from = 6600, to = 6699): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number): void => {
      if (port > to) {
        reject(new Error(`no free port in ${from}-${to}`))
        return
      }
      if (taken.has(port)) {
        attempt(port + 1)
        return
      }
      const probe = createServer()
      probe.once('error', () => attempt(port + 1))
      probe.listen(port, '127.0.0.1', () => probe.close(() => {
        taken.add(port)
        resolve(port)
      }))
    }
    attempt(from)
  })
}

describe('restart, for one server or the panel', () => {
  /**
   * `restart <id>` is the shell's counterpart to the UI's per-server Restart button, which
   * the CLI could not do at all. It must reach the same kind of control route `start`/`stop`
   * use, and leave the panel itself alone.
   */
  it('sends a per-server restart over the local control channel', async () => {
    const created = await panel(200, JSON.stringify({ ok: true }))
    writeRuntime(created.url)

    const result = await runCli(['restart', 'web'])
    expect(result.status).toBe(0)
    // "restarted", not "stopped": the verb is the action.
    expect(result.stdout).toContain('restarted web')
    expect(created.seen.path).toBe('/_hh/servers/web/restart')
    expect(created.seen.token).toBe('local-token')
  })

  it('carries the workspace through', async () => {
    const created = await panel(200, JSON.stringify({ ok: true }))
    writeRuntime(created.url)

    const result = await runCli(['restart', 'web', '--workspace', 'staging'])
    expect(result.status).toBe(0)
    expect(created.seen.path).toBe('/_hh/servers/web/restart?workspace=staging')
    expect(result.stdout).toContain('restarted staging/web')
  })

  it('reports a refused restart as its reason, and exits 1', async () => {
    const created = await panel(409, JSON.stringify({ ok: false, error: 'server "web" is disabled' }))
    writeRuntime(created.url)

    const result = await runCli(['restart', 'web'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('server "web" is disabled')
  })

  /**
   * The id is optional, and that is the delicate half: `restart` meant the panel before this,
   * so a bare call must still take the down-then-up path rather than reaching `/_hh`.
   */
  it('keeps bare `restart` meaning the panel, not a server', async () => {
    // `--print-config` is what makes this safe: bare `restart` runs `down` then `up`, and a
    // real `up` would detach a daemon — which is slow, and on Windows leaves the state
    // directory locked for the cleanup that follows. `--print-config` returns from `up`
    // before it detaches, so the panel path is observable and nothing is started.
    //
    // No run.json either: `down` would otherwise signal the pid in it, and the fixture's pid
    // is this very test process. That is how an earlier draft shot its own worker.
    const result = await runCli(['restart', '--print-config'])

    // The panel path prints the effective config, which a server action never would.
    expect(result.stdout).toContain('servers')
    expect(result.stderr).not.toContain('server id')
  })

  /**
   * `--workspace` without an id is refused rather than ignored.
   *
   * The panel's own restart is not a per-server idea, so the flag is meaningless there — and
   * silently running `down` then `up` would restart *every* server while the caller believed it had
   * scoped the action to one workspace. This branch had no test.
   */
  it('refuses `restart --workspace` when no server id is given', async () => {
    const result = await runCli(['restart', '--workspace', 'default', '--print-config'])

    expect(result.status, 'the flag must be refused, not ignored').toBe(1)
    expect(result.stderr).toContain('restart --workspace needs a server id')
    // It names the corrected form, so the reader does not have to infer it.
    expect(result.stderr).toContain('--workspace <id>')
  })

  it('does not reach the control channel when no id is given', async () => {
    const created = await panel(200, JSON.stringify({ ok: true }))
    writeRuntime(created.url)

    // `restart --workspace x` without an id is refused *before* anything is attempted, so
    // this proves the id-less path never routes to `/_hh` — and it must not run `down`
    // either, because the run.json here names this very process as the panel.
    //
    // This subsumes a sibling case that asserted only exit 1 and `needs a server id`: strictly fewer
    // assertions over the same two calls, so it could not fail where this one passes. The
    // "says what to write instead" half lives in the `--print-config` case above, which is the one
    // that proves the corrected form is named.
    const result = await runCli(['restart', '--workspace', 'staging'])

    expect(result.status).toBe(1)
    expect(created.seen.path, 'the control channel must not be touched').toBeUndefined()
    expect(result.stderr).toContain('needs a server id')
  })
})

describe('start/stop against a live panel', () => {
  it('sends the run.json token to /_hh and reports what the panel answered', async () => {
    const created = await panel(200, JSON.stringify({ ok: true }))
    writeRuntime(created.url)

    const result = await runCli(['start', 'web'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('started web')
    expect(created.seen.path).toBe('/_hh/servers/web/start')
    expect(created.seen.token).toBe('local-token')
  })

  it('turns a refused action into its reason and exit 1', async () => {
    const created = await panel(409, JSON.stringify({ ok: false, error: 'server "web" is disabled' }))
    writeRuntime(created.url)

    const result = await runCli(['stop', 'web'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('server "web" is disabled')
  })

  /** The panel a person already has running is often the previous release. */
  it('names the release when the panel is too old to know the route', async () => {
    const created = await panel(404, 'not found', 'text/plain')
    writeRuntime(created.url, '0.6.4')

    const result = await runCli(['start', 'web'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('home-hosted 0.6.4')
    expect(result.stderr).toContain('does not know this command')
  })
})

/**
 * A stale `run.json` whose pid the OS has since handed to an unrelated process.
 *
 * The pid is genuinely alive, so `isProcessAlive` alone called it a running panel: `up` refused with
 * "already running", `status` said "running, but not answering", and — the dangerous one — `down`
 * SIGTERM'd then SIGKILL'd whatever stranger had inherited the number. The record's own `startedAt`
 * is what tells the two apart, because the daemon stamps it during its own boot and a recycled pid
 * is necessarily born after it.
 */
describe('a stale run.json naming a live stranger\'s pid', () => {
  /**
   * `--print-config` cannot prove this: it returns from `runUp` *before* the live-record guard, so a
   * mutant that reinstated the bare `isProcessAlive` check passed it. The observable has to be the
   * detaching path itself — so this runs a real `up`, on a free port, and asserts the panel it
   * started reports **its own** pid rather than deferring to the stale record.
   */
  it('`up` starts the panel instead of reporting "already running"', async () => {
    const recycled = await recycledPid()
    const port = await freeDevPort()
    writeRuntime('http://127.0.0.1:1', '0.7.19', recycled)

    const started = await runCli(['up', '--port', String(port), '--no-autostart'])
    try {
      expect(started.stdout, 'the stale record must not block a start').not.toContain('already running')
      expect(started.status, started.stderr).toBe(0)
      // Proof the record was replaced by a live one: the panel answers as itself on its own port.
      const status = await runCli(['status', '--json'])
      const json = JSON.parse(status.stdout) as { running?: boolean, liveness?: string, pid?: number, port?: number }
      expect(json.running).toBe(true)
      expect(json.liveness).toBe('live')
      expect(json.pid, 'the panel recorded its own pid, not the stranger\'s').not.toBe(recycled.pid)
      expect(json.port).toBe(port)
      // And the stranger was never touched.
      expect(isProcessAlive(recycled.pid), 'the stranger must not be signalled').toBe(true)
    }
    finally {
      await runCli(['down'])
    }
  })

  /**
   * The safety half, and the reason this is one guard and not five: `down` must never signal a pid
   * that is not this daemon's. Proven by keeping the stranger alive and checking it afterwards.
   *
   * The record is deliberately **not** deleted here. A birth time comes from the wall clock on Linux,
   * so a clock step can make a live panel look recycled; deleting on that verdict would orphan a
   * running panel — still supervising, no longer stoppable. Only a record with nothing behind its pid
   * is removed, which is why the message says the pid was left alone rather than calling it stale.
   */
  it('`down` does not signal the stranger, and leaves its record alone', async () => {
    const recycled = await recycledPid()
    writeRuntime('http://127.0.0.1:1', '0.7.19', recycled)

    const result = await runCli(['down'])

    expect(result.stdout).toContain('not running')
    expect(result.stdout).toContain('belongs to another process')
    // Still alive: the guard held, and no SIGTERM/SIGKILL was aimed at it.
    expect(isProcessAlive(recycled.pid), 'the stranger must not be signalled').toBe(true)
    // Kept, because the birth-time verdict cannot be trusted to be destructive on its own.
    expect(fs.existsSync(path.join(home, '.hh', 'run.json')), 'a possibly-live record is not deleted').toBe(true)
  })

  /**
   * The subtlest case, and the one a first draft of this guard got wrong: a **recycled** pid whose
   * port *is* answered by a panel that accepts the shutdown token.
   *
   * The graceful stop is still offered there, because answering proves the panel is ours — but its
   * own pid is not the one in the record, so the escalation that follows a slow exit must not reach
   * for `runtime.pid`. Without that, an accepted shutdown on a recycled record ended in SIGKILL of
   * the stranger. So: the panel answers, the stranger lives.
   */
  it('`down` never escalates to the recycled pid, even when a panel accepts the stop', async () => {
    // Accepts the shutdown (200) but never exits, so the escalation path is reached.
    const created = await panel(200, JSON.stringify({ ok: true }))
    const recycled = await recycledPid()
    writeRuntime(created.url, '0.7.19', recycled)

    const result = await runCli(['down'])

    expect(result.stdout).toContain('left alone')
    expect(isProcessAlive(recycled.pid), 'the stranger must survive the escalation').toBe(true)
  })

  /** The other half of that rule: a record with *nothing* behind its pid is safely removable. */
  it('`down` removes a record whose pid is really gone', async () => {
    // A pid that certainly does not exist: spawn-and-reap, then reuse the number.
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise<void>(resolve => dead.once('exit', () => resolve()))
    writeRuntime('http://127.0.0.1:1', '0.7.19', { pid: dead.pid!, startedAt: Date.now() })
    const result = await runCli(['down'])

    expect(result.stdout).toContain('stale run.json')
    expect(fs.existsSync(path.join(home, '.hh', 'run.json'))).toBe(false)
  })

  it('`status` reports stale and exits 1, rather than "running, but not answering"', async () => {
    const recycled = await recycledPid()
    writeRuntime('http://127.0.0.1:1', '0.7.19', recycled)

    const result = await runCli(['status'])

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('stale')
    expect(result.stdout, 'a recycled pid is not a panel that is merely wedged').not.toContain('running, but not answering')
    // And the JSON form agrees with the text form, naming the reason.
    const json = JSON.parse((await runCli(['status', '--json'])).stdout) as { running?: boolean, liveness?: string }
    expect(json.running).toBe(false)
    expect(json.liveness).toBe('recycled')
  })

  /**
   * The counter-case that keeps the guard honest: a record whose own pid **is** the live process must
   * still be believed. Without this, a guard that simply called every live pid stale would pass all
   * of the above while breaking the ordinary `up`/`down`/`status` cycle.
   */
  it('believes a record whose pid really is that live process', async () => {
    // This process is alive and started before `Date.now()`, so it is legitimately the panel.
    writeRuntime('http://127.0.0.1:1', '0.7.19', { pid: process.pid, startedAt: Date.now() })
    const result = await runCli(['status', '--json'])

    const json = JSON.parse(result.stdout) as { liveness?: string }
    expect(json.liveness).toBe('live')
  })
})
