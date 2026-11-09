import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { homeFingerprint } from '#src/helpers/paths'
import { isProcessAlive } from '#src/providers/port'
import { downPersistentFixture } from '../support/down-persistent'

/**
 * `down --with-persistent` with no panel at all.
 *
 * That is the case the flag exists for: a persistent entry outlives the panel, so after a
 * crash the state files are the only record of what is still running. Every assertion here
 * uses a real process and a real file, because the whole behaviour is "did that pid die, and
 * did its record go" — a stub would answer neither.
 */

const { home, runCli, spawnStub, listening, zshHome, writeSettings, writePersistent } = downPersistentFixture()

describe('down --with-persistent', () => {
  it('stops a persistent entry and consumes its record, with no panel running', async () => {
    const pid = spawnStub()
    const stateFile = writePersistent('default', 'keep', pid)

    const result = await runCli(['down', '--with-persistent'])
    // No run.json in this home, so this is the "panel is not running" branch — the one that
    // used to return without looking at the entries the panel left behind.
    expect(result.stdout).toContain('home-hosted is not running')
    expect(result.status, result.stderr).toBe(0)

    expect(isProcessAlive(pid), 'the nanny is still running').toBe(false)
    expect(fs.existsSync(stateFile), 'the state file is kept past its process').toBe(false)
    expect(result.stdout).toContain('stopped persistent default/keep')
  })

  it('leaves them running without the flag, and names them instead', async () => {
    const pid = spawnStub()
    const stateFile = writePersistent('default', 'keep', pid)

    const result = await runCli(['down'])
    expect(result.status, result.stderr).toBe(0)

    expect(isProcessAlive(pid)).toBe(true)
    expect(fs.existsSync(stateFile)).toBe(true)
    // The silence about a server the command deliberately left running is the defect this
    // report exists to prevent — a person must not read "stopped" over a live entry.
    expect(result.stdout).toContain('1 persistent server(s) left running: default/keep')
    expect(result.stdout).toContain('--with-persistent')
  })

  it('refuses --with-persistent when a server id names one entry', async () => {
    // `restart <id>` acts on one server; the flag means "every persistent entry, everywhere",
    // and honouring it there would be a different command than the one that was typed.
    const result = await runCli(['restart', 'web', '--with-persistent'])
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('restart <id> restarts one server')
  })

  it('does not signal a nanny whose pid is not the process it names', async () => {
    // A recycled pid must never be signalled: the record is the only witness, and a stranger
    // that inherited the number would be killed in the entry's name.
    const pid = spawnStub()
    // Two minutes of heartbeat age means liveness falls through to the identity check, which
    // this stub fails — so it is not the nanny this record describes.
    const stateFile = writePersistent('default', 'keep', pid, { heartbeatAt: Date.now() - 120_000 })

    const result = await runCli(['down', '--with-persistent'])
    expect(result.status, result.stderr).toBe(0)

    expect(isProcessAlive(pid), 'a stranger was signalled').toBe(true)
    expect(fs.existsSync(stateFile)).toBe(true)
  })
})

/**
 * "Not running" is a claim about the machine, not about the record.
 *
 * With `run.json` gone but a panel still listening, `down` printed "home-hosted is not running" and
 * exited 0 — so `down && up` in a deploy script proceeded against a live panel that then held its
 * port. It now probes the port its own `settings.json` names and refuses, naming where the answer
 * came from. It signals nothing: without a record there is no pid it can prove it owns.
 */
describe('down with no run.json but a panel still answering', () => {
  /** A stand-in panel on the configured port whose `/healthz` names `homeId` (or no home). */
  async function healthz(homeId: string | null): Promise<{ server: http.Server, port: number }> {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status: 'ok', uptimeMs: 1, ...(homeId === null ? {} : { home: homeId }) }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    listening.push(server)
    return { server, port: (server.address() as AddressInfo).port }
  }

  it('refuses, names the address, and touches nothing', async () => {
    zshHome()
    const { server, port } = await healthz(homeFingerprint(home))

    // The state root a panel that lost its record would leave behind: settings naming the port, and
    // no run.json at all.
    writeSettings(port)
    fs.rmSync(path.join(home, '.hh', 'run.json'), { force: true })

    try {
      const result = await runCli(['down'])

      expect(result.status, `a live panel is not a successful stop\n${result.stderr}`).toBe(1)
      expect(result.stderr).toContain(`127.0.0.1:${port}`)
      expect(result.stdout, 'no success line for a panel that is still there').not.toContain('is not running')
      // It reports; it never signals. The listener is still up.
      expect(server.listening, 'down must not touch a process it cannot identify').toBe(true)

      // `restart` is `down` then `up`, and must stop at the failed half: going on started a second
      // panel against this one (here, `--print-config` would have printed the config and exited 0).
      const restart = await runCli(['restart', '--print-config'])
      expect(restart.status, restart.stderr).toBe(1)
      expect(restart.stdout, 'up must not run after a refused down').not.toContain('"servers"')
    }
    finally {
      fs.rmSync(path.join(home, '.hh', 'settings.json'), { force: true })
    }
  })

  /**
   * Two homes can share a port — the user runs two panels, one stopped. Any listener used to count as
   * "this home's panel", so `down` in the stopped home refused over the other one and `status` blamed
   * it. Only a `/healthz` naming this home is this home's panel.
   */
  it('treats another home\'s panel on the same port as not ours: exit 0, nothing touched', async () => {
    zshHome()
    for (const other of ['0123456789abcdef', null]) {
      const { server, port } = await healthz(other)
      writeSettings(port)
      try {
        const result = await runCli(['down'])
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain(`port ${port} is taken by another process`)
        expect(server.listening).toBe(true)
      }
      finally {
        fs.rmSync(path.join(home, '.hh', 'settings.json'), { force: true })
      }
    }
  })

  it('treats a listener that is not a panel at all as not ours', async () => {
    zshHome()
    const server = net.createServer(socket => socket.destroy())
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    listening.push(server)
    const { port } = server.address() as AddressInfo
    writeSettings(port)
    try {
      const result = await runCli(['down'])
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('is taken by another process')
    }
    finally {
      fs.rmSync(path.join(home, '.hh', 'settings.json'), { force: true })
    }
  })

  it('still says "not running" when nothing answers on the configured port', async () => {
    zshHome()
    // A port nothing is on: bind, read the number, close it again.
    const probe = net.createServer()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const { port } = probe.address() as AddressInfo
    await new Promise<void>(resolve => probe.close(() => resolve()))
    writeSettings(port)

    try {
      const result = await runCli(['down'])
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('home-hosted is not running')
    }
    finally {
      fs.rmSync(path.join(home, '.hh', 'settings.json'), { force: true })
    }
  })
})
