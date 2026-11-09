import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { isProcessAlive } from '#src/providers/port'
import { cliPanelFixture } from '../support/cli-panel-fixture'
import { devPortAllocator } from '../support/dev-port'

const { home, runCli, panel, writeRuntime, recycledPid } = await cliPanelFixture()
/** This file's own slice of the dev range (6xxx): the CLI's port preflight runs before its config guard, so a busy 3999 turns a real assertion red. */
const freeDevPort = devPortAllocator(6600, 6699)

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
})
