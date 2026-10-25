import type { ChildProcess } from 'node:child_process'
import type net from 'node:net'
import type { NannyState } from '#src/shared/contracts'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CONFIG_SCHEMA } from '#src/config/migrations'
import { nannyStatePath, writeNannyState } from '#src/providers/nanny'
import { isProcessAlive } from '#src/providers/port'

/**
 * `down --with-persistent` with no panel at all.
 *
 * That is the case the flag exists for: a persistent entry outlives the panel, so after a
 * crash the state files are the only record of what is still running. Every assertion here
 * uses a real process and a real file, because the whole behaviour is "did that pid die, and
 * did its record go" — a stub would answer neither.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-down-persistent-'))
const spawned: ChildProcess[] = []

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

/** A long-lived process standing in for a nanny, killed whatever the test does. */
function spawnStub(): number {
  const child = spawn(process.execPath, ['-e', 'process.on(\'SIGTERM\', () => process.exit(0)); setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  child.unref()
  spawned.push(child)
  return child.pid!
}

/**
 * A workspace whose `.state` describes one running persistent entry.
 *
 * The servers config declares the entry so the stop can read *its* policy rather than the
 * defaults — that is the difference this test would otherwise not see.
 */
function writePersistent(
  workspaceId: string,
  serverId: string,
  nannyPid: number,
  overrides: Partial<NannyState> = {},
  config: Record<string, unknown> = {},
): string {
  const stateDir = path.join(home, '.hh', workspaceId, '.state')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.mkdirSync(path.join(home, '.hh', workspaceId), { recursive: true })
  fs.writeFileSync(path.join(home, '.hh', workspaceId, 'settings.json'), '{}\n')
  // Stamped as the current schema: an unstamped file reads as the oldest shape, which has a
  // migration pending and is therefore refused — the stop would fall back to default policy.
  fs.writeFileSync(path.join(home, '.hh', workspaceId, 'servers.config.json'), `${JSON.stringify({
    $schema: './servers.config.schema.json',
    meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
    servers: [{ id: serverId, command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], persistent: true, autostart: false, ...config }],
  }, null, 2)}\n`)
  const file = nannyStatePath(stateDir, serverId)
  writeNannyState(file, {
    serverId,
    nannyPid,
    childPid: null,
    startedAt: Date.now(),
    logFile: path.join(home, '.hh', workspaceId, '.logs', `${serverId}.log`),
    heartbeatAt: Date.now(),
    ...overrides,
  } as NannyState)
  return file
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    if (child.pid !== undefined && isProcessAlive(child.pid)) {
      try {
        child.kill('SIGKILL')
      }
      catch {
        // Already gone.
      }
    }
  }
})

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
    expect(result.status).toBe(1)
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

  it('stops through a running panel, which is the path that must report what it stopped', async () => {
    // The panel path is what `restart --with-persistent` relies on to know what to start back:
    // when it stopped the entry but reported nothing, the restart left down the thing it was
    // asked to restart (measured on a real host). This pins both halves — the request carrying
    // the flag, and the entry still being reported as stopped once the panel has ended it.
    //
    // Through a **spawned** CLI with its own home: calling `runDown` in-process would inherit
    // this machine's `HHOSTED_HOME` and drive whichever panel is really running.
    const pid = spawnStub()
    writePersistent('default', 'keep', pid)

    const seen: string[] = []
    const server = http.createServer((request, response) => {
      seen.push(`${request.method} ${request.url ?? ''}`)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true }))
      // A real panel exits once its shutdown is answered; the record's pid has to go with it,
      // or `down` waits out its 20s force-stop window before this test can assert anything.
      if (request.url === '/_hh/shutdown')
        process.kill(pid, 'SIGTERM')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    const runFile = path.join(home, '.hh', 'run.json')
    fs.mkdirSync(path.dirname(runFile), { recursive: true })
    fs.writeFileSync(runFile, JSON.stringify({
      version: '0.10.0',
      // A live pid the record itself vouches for: started just now, so `startedAt` matches and
      // the CLI does not read it as a recycled pid.
      pid,
      url: `http://127.0.0.1:${port}`,
      probeUrl: `http://127.0.0.1:${port}`,
      protocol: 'http',
      port,
      bindHost: '127.0.0.1',
      startedAt: Date.now(),
      projectDir: home,
      dataRoot: home,
      configPath: path.join(home, '.hh', 'default', 'servers.config.json'),
      logFile: path.join(home, '.hh', '.logs', 'home-hosted.log'),
      token: 'local-token',
    }))

    try {
      const result = await runCli(['down', '--with-persistent'])
      expect(result.stderr, 'the CLI failed').toBe('')
      // The flag rides the shutdown call, so the panel ends the entries itself while it is still
      // alive to record the stop. A bare `/_hh/shutdown` here would leave them running.
      expect(seen).toContain('POST /_hh/shutdown?withPersistent=true')
      expect(result.stdout).toContain('stopped persistent default/keep')
    }
    finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      fs.rmSync(runFile, { force: true })
    }
  })

  // Windows has no catchable SIGINT: `process.kill(pid, 'SIGINT')` terminates the process instead
  // of raising a handler, so the marker this test reads is never written. The product path is
  // `signalPid`'s win32 branch, which cannot express a POSIX signal at all — a platform limitation,
  // stated here rather than asserted as if it worked (`RELEASING.md`: use `it.runIf`, computed at
  // module load).
  it.runIf(process.platform !== 'win32')('honours the entry’s own stop policy instead of a hard-coded grace period', async () => {
    // The nanny forwards the entry's `stop.signal` to the child it owns, so the signal this
    // sends is the one the config asked for. A hard-coded SIGTERM here would stop a service
    // with a signal its author deliberately did not choose.
    const script = `
      const fs = require('node:fs')
      process.on('SIGINT', () => {
        fs.writeFileSync(process.env.MARKER, 'int')
        process.exit(0)
      })
      process.on('SIGTERM', () => {
        fs.writeFileSync(process.env.MARKER, 'term')
        process.exit(0)
      })
      setInterval(() => {}, 1000)
    `
    // A nanny that traps SIGTERM and does nothing: only the config's SIGINT may stop it.
    const marker = path.join(home, 'signal.txt')
    const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', env: { ...process.env, MARKER: marker } })
    child.unref()
    spawned.push(child)

    const stateFile = writePersistent('default', 'keep', child.pid!, { childPid: child.pid! }, {
      stop: { signal: 'SIGINT', killGroup: false, graceMs: 4000, killPortHolders: false },
    })

    const result = await runCli(['down', '--with-persistent'])
    expect(result.status, result.stderr).toBe(0)
    expect(fs.readFileSync(marker, 'utf8'), 'the configured signal was not the one delivered').toBe('int')
    expect(fs.existsSync(stateFile)).toBe(false)
  })

  it('keeps the record of an entry the stop could not end', async () => {
    // `SIGKILL` is not survivable, so the survivor cannot be produced with a real pid: the
    // terminator is the seam. Everything else in the sweep is the shipped code, and what it
    // must not do is delete the record of a process it did not end.
    const pid = spawnStub()
    const stateFile = writePersistent('default', 'keep', pid)

    const { livePersistentEntries, stopPersistentEntries } = await import('#src/providers/nanny-sweep')
    const handles = await livePersistentEntries(path.join(home, '.hh'))
    expect(handles.map(handle => handle.serverId)).toEqual(['keep'])

    const results = await stopPersistentEntries(handles, {
      // A terminator that reports success and leaves the process alive: the one shape a real
      // EPERM produces, and the one the record must survive.
      terminate: async () => 'exited',
    })

    expect(results[0]!.stopped).toBe(false)
    expect(results[0]!.error).toContain('survived the stop')
    expect(fs.existsSync(stateFile), 'the record of a live nanny was consumed').toBe(true)
  })

  it('a survivor makes the command exit 1 rather than claim the host is down', async () => {
    // The exit code is the contract a script reads: a stop that left a server running is a
    // failed stop, and "down" printing exit 0 over it is the empty-success defect.
    // A pure function over its argument: it reads no state directory, so importing it here
    // cannot reach a real host the way an in-process `runDown` could.
    const { exitCodeForStops } = await import('#src/cli/down')
    expect(exitCodeForStops([{ stopped: true }])).toBe(0)
    expect(exitCodeForStops([{ stopped: true }, { stopped: false }])).toBe(1)
  })
})
