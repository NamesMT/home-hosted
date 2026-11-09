import type net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { isProcessAlive } from '#src/providers/port'
import { cliPanelFixture } from '../support/cli-panel-fixture'

const { home, runCli, servers, panel, writeRuntime, recycledPid } = await cliPanelFixture()

/** The first case of this group, a real `up` over the stale record, is in `server-action-up.test.ts`. */
describe('a stale run.json naming a live stranger\'s pid', () => {
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

    expect(result.status, result.stderr).toBe(1)
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
    expect(result.status, result.stderr).toBe(0)
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
    expect(result.status, result.stderr).toBe(0)
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
    expect(result.status, result.stderr).toBe(1)
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
    expect(result.status, result.stderr).toBe(0)
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
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('still in use')
    expect(result.stdout).not.toContain('started web')
  })

  it('does not accept --free-port on a command that has no use for it', async () => {
    // `stop --free-port` would free a port and then stop the entry that wanted it.
    const result = await runCli(['stop', 'web', '--free-port'])
    expect(result.status).not.toBe(0)
  })
})
