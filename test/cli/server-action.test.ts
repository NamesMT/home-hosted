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
  /** The last **action** request — never the read-back `start` now makes. */
  seen: { path?: string, token?: string, readBack?: string }
}

/** A throwaway panel that answers one status and body, and records what it was asked. */
async function panel(status: number, body: string, contentType = 'application/json'): Promise<Panel> {
  const seen: Panel['seen'] = {}
  const server = http.createServer((req, res) => {
    seen.token = req.headers['x-home-hosted-token'] as string | undefined
    // A real panel answers a read-back as well as the action, and `start` now asks for one: a stub
    // that replays the action's `{ ok: true }` for every request describes an entry with no
    // `status`, which is exactly the shape `start` refuses. The read-back is recorded apart, so a
    // test that asserts which *action* was sent still reads the action.
    if (req.method === 'GET' && req.url?.startsWith('/_hh/servers/')) {
      seen.readBack = req.url
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id: 'web', status: 'running', lastError: null }))
      return
    }
    seen.path = req.url
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

/**
 * `up` on a live panel, driven end to end.
 *
 * The unit tests in `up-flags.test.ts` pin the sentence `alreadyRunningConflict` produces, and that
 * is not the same thing as `up` *calling* it: deleting the whole call site left all seven of them
 * green, which is how a regression where `--host` refused an agreeing bind shipped. These run the
 * real command against a real `run.json`, so the wiring is what is under test.
 */
describe('up against a live panel', () => {
  /** A run.json the CLI accepts, bound to `bindHost` on `port`. */
  function writeLiveRuntime(port: number, bindHost: string): void {
    const file = path.join(home, '.hh', 'run.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({
      version: '0.11.0',
      pid: process.pid,
      url: `http://127.0.0.1:${port}`,
      probeUrl: `http://127.0.0.1:${port}`,
      protocol: 'http',
      port,
      bindHost,
      startedAt: Date.now(),
      projectDir: home,
      dataRoot: home,
      configPath: path.join(home, '.hh', 'default', 'servers.config.json'),
      logFile: path.join(home, '.hh', '.logs', 'home-hosted.log'),
      token: 'local-token',
    }, null, 2)}\n`)
  }

  afterEach(() => {
    fs.rmSync(path.join(home, '.hh', 'run.json'), { force: true })
  })

  it('exits 0 and says nothing about a flag that agrees, including --host', async () => {
    writeLiveRuntime(3999, '127.0.0.1')
    // `--host local` resolves to 127.0.0.1, which is the bind the record already has.
    const result = await runCli(['up', '--port', '3999', '--host', 'local'])
    expect(result.stderr, 'an agreeing re-run must not refuse').toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('already running')
  })

  it('refuses a --host that names a different bind, and says where the panel is', async () => {
    writeLiveRuntime(3999, '0.0.0.0')
    // `local` against a panel bound to 0.0.0.0 is a real move, so it is refused.
    const result = await runCli(['up', '--host', 'local'])
    expect(result.status, 'a contradicted flag must exit 1').toBe(1)
    expect(result.stderr).toContain('--host local was not honoured')
    // stdout stays empty, so nothing reads as a success line for a move that did not happen.
    expect(result.stdout).not.toContain('already running')
  })

  it('lets an explicit address through when it is the live bind', async () => {
    writeLiveRuntime(3999, '0.0.0.0')
    const result = await runCli(['up', '--host', '0.0.0.0'])
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})

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

  /**
   * `restart <id>` takes no panel option, and says so instead of dropping it.
   *
   * The command spreads `up`'s whole flag set, because the **bare** form really does forward it —
   * `restart --print-config` is how the panel path is observable, pinned above. The id form is a
   * different command: it asks the panel to restart one entry over `/_hh` and never runs `down` or
   * `up`, so a panel-level flag has nothing to act on. They were parsed and discarded, which is how
   * `restart web --print-config` came to restart a live server while reading as "show me the
   * config". `--with-persistent` already had this guard; these six did not.
   */
  it('refuses a panel-level flag on `restart <id>`, and names it', async () => {
    const cases = [
      ['--port', '5000'],
      ['--host', 'lan'],
      ['--no-autostart'],
      ['--open'],
      ['--foreground'],
      ['--print-config'],
    ] as const

    for (const extra of cases) {
      const created = await panel(200, JSON.stringify({ ok: true }))
      writeRuntime(created.url)

      const result = await runCli(['restart', 'web', ...extra])

      expect(result.status, extra.join(' ')).toBe(1)
      expect(result.stderr, extra.join(' ')).toContain('takes no panel option')
      // It names the flag, so the reader does not have to work out which one was dropped.
      expect(result.stderr, extra.join(' ')).toContain(extra[0])
      // And nothing reached the panel: a refusal must not restart the entry on its way out.
      expect(created.seen.path, extra.join(' ')).toBeUndefined()
    }

    // `--port=5000` is one token, and must be refused the same way.
    const created = await panel(200, JSON.stringify({ ok: true }))
    writeRuntime(created.url)
    const equals = await runCli(['restart', 'web', '--port=5000'])
    expect(equals.status).toBe(1)
    expect(equals.stderr).toContain('takes no panel option')

    // The bare form still forwards it — the flag is not wrong, only wrong *here*.
    //
    // With **no** run.json: the fixture's pid is this very process, and bare `restart` runs `down`,
    // which would signal it. The sibling test above carries the same warning; this is the second
    // time it has been earned.
    fs.rmSync(path.join(home, '.hh', 'run.json'), { force: true })
    const bare = await runCli(['restart', '--print-config'])
    expect(bare.status, 'a bare restart still honours --print-config').toBe(0)
    expect(bare.stdout).toContain('servers')
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

/**
 * `free-port`, and `start --free-port`.
 *
 * The panel has had a **Free port** button since the beginning; the shell had no way to reach it,
 * so the one situation a headless operator actually hits — "the panel says the port is taken and
 * I am over SSH" — had no answer. The route already existed under `/api` for the button; this
 * drives it through the local channel, which needs no session.
 *
 * Four behaviours, and the difference between them is the whole point:
 *
 *  - `free-port` with a stranger on the port: signalled, reports the pid, exit 0;
 *  - `free-port` with nothing listening: **refused**, because the person asked to free something;
 *  - `start --free-port` with nothing listening: proceeds, because a free port is the goal;
 *  - `start --free-port` where the port survives: exit 1, so a script knows the start will fail.
 */
describe('free-port, and start --free-port', () => {
  it('reports what it stopped, and the path it called', async () => {
    const fake = await panel(200, JSON.stringify({
      ok: true,
      port: 4010,
      terminated: [4242],
      forced: [],
      skipped: [],
      free: true,
    }))
    writeRuntime(fake.url)

    const result = await runCli(['free-port', 'web'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('freed port 4010')
    expect(result.stdout).toContain('4242')
    // The local channel, not `/api`: no session, just run.json's token.
    expect(fake.seen.path).toBe('/_hh/servers/web/free-port')
    expect(fake.seen.token).toBe('local-token')
  })

  it('names a port it had to kill, separately from one it asked to stop', async () => {
    const fake = await panel(200, JSON.stringify({
      ok: true,
      port: 4010,
      terminated: [11],
      forced: [22],
      skipped: [],
      free: true,
    }))
    writeRuntime(fake.url)

    const result = await runCli(['free-port', 'web'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('pid 11 stopped')
    expect(result.stdout).toContain('pid 22 had to be killed')
  })

  it('reports a holder this panel supervises instead of signalling it', async () => {
    const fake = await panel(409, JSON.stringify({
      ok: true,
      port: 4010,
      terminated: [],
      forced: [],
      skipped: [33],
      free: true,
    }))
    writeRuntime(fake.url)

    const result = await runCli(['free-port', 'web'])
    expect(result.stdout).toContain('pid 33 left alone')
    expect(result.stdout).toContain('supervises')
  })

  it('refuses when nothing is listening, because that is not what was asked', async () => {
    const fake = await panel(409, JSON.stringify({
      ok: false,
      port: 4010,
      terminated: [],
      forced: [],
      skipped: [],
      free: false,
      error: 'nothing is listening on port 4010 any more',
    }))
    writeRuntime(fake.url)

    const result = await runCli(['free-port', 'web'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('nothing is listening on port 4010')
  })

  it('lets start --free-port proceed when the port is already idle', async () => {
    // The panel refuses `free-port` with "nothing is listening"; `start` wants the port free, so
    // that answer is the desired state and must not abort the start. The stub answers by path,
    // because a real panel says this to the free-port call and *then* starts the entry.
    const seen: string[] = []
    const server = http.createServer((req, res) => {
      // `start` reads the entry back after spawning, so that request is not one of the two calls
      // this test is about — answered apart rather than recorded, so the `seen` list stays exactly
      // the free-port/start pair.
      if (req.method === 'GET') {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id: 'web', status: 'running', lastError: null }))
        return
      }
      seen.push(req.url ?? '')
      const isFreePort = (req.url ?? '').includes('free-port')
      res.statusCode = isFreePort ? 409 : 200
      res.setHeader('content-type', 'application/json')
      res.end(isFreePort
        ? JSON.stringify({
            ok: false,
            port: 4010,
            terminated: [],
            forced: [],
            skipped: [],
            free: false,
            error: 'nothing is listening on port 4010 any more',
          })
        : JSON.stringify({ ok: true }))
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as net.AddressInfo
    writeRuntime(`http://127.0.0.1:${address.port}`)

    const result = await runCli(['start', 'web', '--free-port'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('port is free')
    expect(result.stdout).toContain('started web')
    // Both calls happened, in that order — the flag composes rather than replacing.
    expect(seen).toEqual(['/_hh/servers/web/free-port', '/_hh/servers/web/start'])
  })

  it('never lets start --free-port continue when the port stays taken', async () => {
    // The mirror case: a socket that survived. The start would fail anyway, so say why here.
    const fake = await panel(200, JSON.stringify({
      ok: true,
      port: 4010,
      terminated: [11],
      forced: [],
      skipped: [],
      free: false,
    }))
    writeRuntime(fake.url)

    const result = await runCli(['start', 'web', '--free-port'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('still in use')
    expect(result.stdout).not.toContain('started web')
  })

  it('does not accept --free-port on a command that has no use for it', async () => {
    // `stop --free-port` would free a port and then stop the entry that wanted it.
    const result = await runCli(['stop', 'web', '--free-port'])
    expect(result.status).not.toBe(0)
  })
})
