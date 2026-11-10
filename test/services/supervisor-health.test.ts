import net from 'node:net'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { freePort, makeSupervisor, portAccepts, runCleanups, view, waitFor, waitForStatus } from '../support/supervisor-harness'

afterEach(runCleanups)

/**
 * A force restart needs a budget, the same way a crash does.
 *
 * `restart.maxRetries` bounded crashes only. `shouldForceRestart` restarted an unhealthy entry
 * with no counter, no backoff and no give-up — the operator audit measured 16 forced restarts in
 * a minute on a server whose `/healthz` always answered 500, and it would have gone on forever.
 */
describe('the health restart budget', () => {
  /**
   * Giving up must stop it, not just relabel it: `stopped` with a live pid is a false report that
   * `/healthz` and every card read.
   */
  it('stops a permanently unhealthy entry, and says why, instead of restarting it forever', async () => {
    const port = await freePort()
    const harness = await makeSupervisor([{
      id: 'sick',
      command: process.execPath,
      // Always 500: up, serving, and never healthy.
      args: ['-e', 'require("node:http").createServer((q,s)=>{s.statusCode=500;s.end("no")}).listen(Number(process.env.PORT),"127.0.0.1")'],
      env: { PORT: '{port}' },
      port,
      health: { mode: 'http', intervalMs: 500, timeoutMs: 300, unhealthyThreshold: 1, forceRestartAfterMs: 200, startTimeoutMs: 5000 },
      restart: { enabled: true, maxRetries: 2, baseDelayMs: 50, factor: 2, maxDelayMs: 200, resetAfterMs: 60000 },
    }])

    await harness.supervisor.start('sick')
    await waitFor(() => view(harness.supervisor, 'sick').status === 'stopped' && view(harness.supervisor, 'sick').lastError !== null, 45000)

    const givenUp = view(harness.supervisor, 'sick')
    expect(givenUp.lastError).toContain('health restarts')
    // The process must be gone: a `stopped` entry with a live pid is the false report this fixes.
    expect(givenUp.pid, 'a stopped entry must have no pid').toBeNull()
    expect(givenUp.status).toBe('stopped')
    // …and nothing listens on its port any more.
    expect(await portAccepts(port), 'the stopped entry must have released its port').toBe(false)
    // The budget is `maxRetries`, so it cannot have restarted more than that many times.
    expect(givenUp.history.forcedRestarts).toBeLessThanOrEqual(2)
  })

  it('does not restart a health-failing entry at all when restarts are disabled', async () => {
    const port = await freePort()
    const harness = await makeSupervisor([{
      id: 'sick',
      command: process.execPath,
      args: ['-e', 'require("node:http").createServer((q,s)=>{s.statusCode=500;s.end("no")}).listen(Number(process.env.PORT),"127.0.0.1")'],
      env: { PORT: '{port}' },
      port,
      health: { mode: 'http', intervalMs: 500, timeoutMs: 300, unhealthyThreshold: 1, forceRestartAfterMs: 200, startTimeoutMs: 5000 },
      restart: { enabled: false, maxRetries: 3, baseDelayMs: 50, factor: 2, maxDelayMs: 200, resetAfterMs: 60000 },
    }])

    await harness.supervisor.start('sick')
    // `stopped`, not `crashed`: giving up now actually stops the process, so the status and the pid
    // agree. The reason is still on `lastError`.
    await waitFor(() => view(harness.supervisor, 'sick').status === 'stopped' && view(harness.supervisor, 'sick').lastError !== null, 30000)
    expect(view(harness.supervisor, 'sick').pid).toBeNull()
    expect(view(harness.supervisor, 'sick').history.forcedRestarts).toBe(0)
  })
})

/**
 * Health describes a process, and must not outlive it.
 *
 * With `onPortConflict: "warn"` and a stranger already on the port, the entry's own process dies
 * with EADDRINUSE — and the probe, which cannot tell whose listener answers, kept reporting
 * `healthy`. The card then read `status: crashed, health: healthy, pid: None`: green, for a
 * process that did not exist. An external monitor watching `health` saw the same lie.
 */
describe('health of a dead entry', () => {
  it('does not keep a healthy verdict after the process is gone', async () => {
    const port = await freePort()
    // A stranger holds the port; the entry's own process cannot bind and dies.
    const stranger = net.createServer()
    await new Promise<void>(resolve => stranger.listen(port, '127.0.0.1', () => resolve()))

    const harness = await makeSupervisor([{
      id: 'clash',
      command: process.execPath,
      args: ['-e', 'require("node:http").createServer((q,s)=>s.end("ok")).listen(Number(process.env.PORT),"127.0.0.1"); setInterval(()=>{},1000)'],
      env: { PORT: '{port}' },
      port,
      onPortConflict: 'warn',
      health: { intervalMs: 500, timeoutMs: 300, unhealthyThreshold: 3, forceRestartAfterMs: 0, startTimeoutMs: 3000 },
      restart: { maxRetries: 0, baseDelayMs: 50, factor: 2, maxDelayMs: 200, resetAfterMs: 60000 },
    }])

    try {
      await harness.supervisor.start('clash')
      // Once it has given up, the entry says so — and its health must not still read green.
      await waitFor(() => view(harness.supervisor, 'clash').status === 'crashed', 20000)
      const dead = view(harness.supervisor, 'clash')
      expect(dead.pid).toBeNull()
      expect(dead.health, `a dead entry must not report healthy — got ${JSON.stringify({ status: dead.status, health: dead.health })}`).not.toBe('healthy')
    }
    finally {
      await new Promise<void>(resolve => stranger.close(() => resolve()))
    }
  })
})

/**
 * `dependsOn` means "healthy first", and the boot path is the one that skipped it.
 *
 * `startDependencies` returned early whenever the dependency already had a child, and on
 * `start-all`/boot `orderByDependencies` has already spawned every dependency — so the
 * readiness wait never ran. `awaitReadiness` is fire-and-forget, so `start()` answers at
 * spawn; a dependent could therefore be serving seconds before its dependency bound its port.
 * Both docs promise the opposite ("waits for a dependency to be *healthy* — not merely spawned").
 */
describe('dependsOn readiness', () => {
  /** Each side of a two-entry cycle waited out the other's whole `startTimeoutMs` (20 s by default). */
  it('starts both sides of a dependsOn cycle without waiting out a timeout', async () => {
    const worker = (id: string, dependsOn: string[]): Record<string, unknown> => ({
      id,
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      dependsOn,
      health: { enabled: false, startTimeoutMs: 15000 },
      restart: { enabled: false },
    })
    const { supervisor } = await makeSupervisor([worker('a', ['b']), worker('b', ['a'])])

    const began = Date.now()
    expect((await supervisor.start('a')).ok).toBe(true)
    await waitFor(() => view(supervisor, 'a').status === 'running' && view(supervisor, 'b').status === 'running', 20000)
    expect(Date.now() - began).toBeLessThan(8000)
  }, 30000)

  it('does not start the dependent until the dependency is accepting connections', async () => {
    const slowPort = await freePort()
    const needsPort = await freePort()
    const harness = await makeSupervisor([
      {
        id: 'slow',
        command: process.execPath,
        // Takes a full second to bind, so "spawned" and "serving" are far apart.
        args: ['-e', 'setTimeout(()=>require("node:http").createServer((q,s)=>s.end("ok")).listen(Number(process.env.PORT),"127.0.0.1"),1000); setInterval(()=>{},1000)'],
        env: { PORT: '{port}' },
        port: slowPort,
        health: { intervalMs: 500, timeoutMs: 300, unhealthyThreshold: 3, forceRestartAfterMs: 0, startTimeoutMs: 15000 },
        restart: { maxRetries: 0, baseDelayMs: 50, factor: 2, maxDelayMs: 200, resetAfterMs: 60000 },
      },
      {
        id: 'needs',
        command: process.execPath,
        args: ['-e', 'require("node:http").createServer((q,s)=>s.end("ok")).listen(Number(process.env.PORT),"127.0.0.1")'],
        env: { PORT: '{port}' },
        port: needsPort,
        dependsOn: ['slow'],
        health: { intervalMs: 500, timeoutMs: 300, unhealthyThreshold: 3, forceRestartAfterMs: 0, startTimeoutMs: 15000 },
        restart: { maxRetries: 0, baseDelayMs: 50, factor: 2, maxDelayMs: 200, resetAfterMs: 60000 },
      },
    ])

    // The boot path: `orderByDependencies` spawns `slow` first, then `needs` walks into
    // `startDependencies` while `slow` is spawned-but-not-yet-listening.
    await harness.supervisor.startAll()
    await waitFor(() => harness.supervisor.views().every(view => view.status === 'running'), 25000)

    // The dependent's own log is the evidence: it must record that it waited.
    const slowLines = harness.supervisor.logLines('slow', 50).map(line => line.text)
    const slowReady = slowLines.find(text => text.includes('accepting connections'))
    expect(slowReady, `slow log was: ${JSON.stringify(slowLines)}`).toBeDefined()
    // And the timing: the dependent started after the dependency was serving. The
    // regression made this gap ~0 because the wait was skipped entirely.
    const slowStart = view(harness.supervisor, 'slow').startedAt ?? 0
    const needsStart = view(harness.supervisor, 'needs').startedAt ?? 0
    expect(needsStart - slowStart).toBeGreaterThanOrEqual(900)
  })
})

/**
 * `dependsOn` promises "healthy", and in `http` mode a listening socket is not that.
 *
 * `awaitReadiness` set `health = 'healthy'` on the first TCP accept — correct for `port` mode,
 * where the accept *is* the probe, but wrong for `http` mode, where a server can listen and answer
 * 500 to everything. `isReady` then accepted `not unhealthy`, which `unknown` satisfies, so a
 * dependent started against a dependency nobody had probed.
 */
describe('http health and dependsOn', () => {
  it('does not treat a listening-but-failing dependency as ready', async () => {
    const dependsPort = await freePort()
    const brokenPort = await freePort()
    const harness = await makeSupervisor([
      {
        id: 'broken',
        command: process.execPath,
        // Binds at once and answers 500 forever: listening, and not healthy.
        args: ['-e', 'require("node:http").createServer((q,s)=>{s.statusCode=500;s.end("no")}).listen(Number(process.env.PORT),"127.0.0.1")'],
        env: { PORT: '{port}' },
        port: brokenPort,
        health: { mode: 'http', intervalMs: 500, timeoutMs: 300, unhealthyThreshold: 1, forceRestartAfterMs: 0, startTimeoutMs: 3000 },
        restart: { maxRetries: 0, baseDelayMs: 50, factor: 2, maxDelayMs: 200, resetAfterMs: 60000 },
      },
      {
        id: 'dependent',
        command: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        port: dependsPort,
        dependsOn: ['broken'],
        health: { mode: 'port', intervalMs: 500, timeoutMs: 300, unhealthyThreshold: 3, forceRestartAfterMs: 0, startTimeoutMs: 3000 },
        restart: { maxRetries: 0, baseDelayMs: 50, factor: 2, maxDelayMs: 200, resetAfterMs: 60000 },
      },
    ])

    await harness.supervisor.startAll()
    await waitFor(() => harness.supervisor.views().every(entry => entry.status === 'running'), 20000)

    // The dependency was probed and found unhealthy before the dependent was released; the
    // "starting anyway" line is the timeout path, which is the only correct way past here.
    const lines = harness.supervisor.logLines('dependent', 50).map(line => line.text)
    expect(lines.some(text => text.includes('starting anyway')), `dependent log: ${JSON.stringify(lines)}`).toBe(true)
    expect(harness.supervisor.views().find(entry => entry.id === 'broken')?.health).toBe('unhealthy')
  })
})

/**
 * Stopping a dependency names the dependents it leaves running.
 *
 * `stopAll` stops dependents first (`orderByDependencies(...).reverse()`), but a single stop does not
 * cascade — and it used to say nothing at all, so a person could stop `db` and be told it worked while
 * `app` kept serving against a database that was gone. The panel reports `app` as running, and nothing
 * connects the two facts.
 */
describe('stopping a dependency', () => {
  it('names the dependents left running, and stays quiet when there are none', async () => {
    const harness = await makeSupervisor([
      { id: 'db', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
      { id: 'app', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], dependsOn: ['db'] },
    ])

    // Both up, so the dependent is genuinely active when its dependency stops.
    await harness.supervisor.startAll()
    const started = await waitFor(() => harness.supervisor.views().filter(view => view.status === 'running').length === 2)
    expect(started, 'both servers must be running for this to prove anything').toBe(true)

    await harness.supervisor.stop('db')

    const lines = harness.supervisor.logLines('db', 50).map(line => line.text)
    expect(lines.some(text => text.includes('still running and depending on this: app')), `log was: ${JSON.stringify(lines.slice(-6))}`).toBe(true)

    // A server nothing depends on says nothing extra.
    const alone = await makeSupervisor([{ id: 'solo', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }])
    await alone.supervisor.startAll()
    await waitFor(() => alone.supervisor.views()[0]?.status === 'running')
    await alone.supervisor.stop('solo')
    const soloLines = alone.supervisor.logLines('solo', 50).map(line => line.text)
    expect(soloLines.some(text => text.includes('still running and depending on this'))).toBe(false)
  })
})

/**
 * The tests beside these three defects all passed while the defects were present, because their
 * fake servers either really recovered or never did. These drive the shapes that broke.
 */
describe('the health budget and the recovery it announces', () => {
  it('does not announce a restart as served when http mode has not probed yet', async () => {
    const port = await freePort()
    const harness = await makeSupervisor([{
      id: 'liar',
      command: process.execPath,
      // Spawns, accepts TCP, answers 500 to every request: "up" and not serving.
      args: ['-e', 'require("node:http").createServer((q,s)=>{s.statusCode=500;s.end("no")}).listen(Number(process.env.PORT),"127.0.0.1")'],
      env: { PORT: '{port}' },
      port,
      health: { mode: 'http', intervalMs: 2000, timeoutMs: 300, unhealthyThreshold: 1, forceRestartAfterMs: 0, startTimeoutMs: 5000 },
      restart: { enabled: true, maxRetries: 2, baseDelayMs: 50, factor: 1, maxDelayMs: 50, resetAfterMs: 60000 },
    }])

    await harness.supervisor.start('liar')
    await waitFor(() => view(harness.supervisor, 'liar').health === 'unhealthy', 15000)

    // A force restart is announced before it happens, so its outcome is owed — but the outcome is
    // not known at the TCP accept, and this server never serves a 200.
    const entry = harness.supervisor as unknown as { entries: Map<string, { pendingRestart: unknown }> }
    const e = entry.entries.get('liar')!
    e.pendingRestart = { cause: 'the test forced one' }
    const notify = vi.spyOn(harness.supervisor as unknown as { notify: () => void }, 'notify')
    await harness.supervisor.restart('liar')
    await waitFor(() => view(harness.supervisor, 'liar').health === 'unhealthy', 15000)

    const announced = notify.mock.calls.some(call => (call as unknown as [string, string])[1] === 'restart-ok')
    expect(announced, 'a server answering 500 was announced as serving again').toBe(false)
  }, 60000)

  it('does not refill the budget after one healthy probe', async () => {
    const port = await freePort()
    // Healthy for the first request only, then 500 forever: one 200 per life.
    const harness = await makeSupervisor([{
      id: 'flaky',
      command: process.execPath,
      args: ['-e', 'let n=0;require("node:http").createServer((q,s)=>{n++;s.statusCode=n===1?200:500;s.end("x")}).listen(Number(process.env.PORT),"127.0.0.1")'],
      env: { PORT: '{port}' },
      port,
      health: { mode: 'http', intervalMs: 500, timeoutMs: 300, unhealthyThreshold: 1, forceRestartAfterMs: 400, startTimeoutMs: 5000 },
      restart: { enabled: true, maxRetries: 2, baseDelayMs: 30, factor: 1, maxDelayMs: 30, resetAfterMs: 600000 },
    }])

    const res = await harness.supervisor.start('flaky')
    expect(res.ok, `the fixture must actually start: ${res.error ?? ''}`).toBe(true)
    // It must stop rather than restart forever: the budget is 2, and `resetAfterMs` is far away.
    // Read defensively — a view can disappear between ticks if the entry exits. Not `async`:
    // `waitFor` treats any truthy return as done, and a Promise is always truthy.
    const stopped = (): boolean =>
      harness.supervisor.views().some(entry => entry.id === 'flaky' && (entry.status === 'stopped' || entry.status === 'crashed'))
    await waitFor(stopped, 45000)
    const finished = harness.supervisor.views().find(entry => entry.id === 'flaky')
    expect(finished, 'the entry must have reached a settled state').toBeDefined()
    // Bounded: with one 200 refilling the budget it restarts without end (6 in 20s, measured).
    expect(finished!.history.forcedRestarts).toBeLessThanOrEqual(3)
  }, 60000)
})

/**
 * A start someone asked for clears the give-up flag, and that is load-bearing: with it left
 * standing, a running and healthy entry keeps `stoppedByPanel`, and `/healthz` answers 503 for a
 * server that is serving.
 *
 * The flag is seeded rather than produced by a real give-up sequence: that sequence is a race
 * between the health probe and the force-restart timer, and it resolved differently on Windows than
 * on Linux (it timed out on the release gate). What is under test is that `start()` clears the flag,
 * which a seeded flag pins exactly — and still fails when the line is removed.
 */
describe('the give-up flag does not outlive the give-up', () => {
  it('is cleared by a manual start', async () => {
    const harness = await makeSupervisor([{ id: 'sick', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }])

    // The state a give-up leaves behind: stopped, with the flag and the reason.
    const entries = (harness.supervisor as unknown as { entries: Map<string, { status: string, lastError: string | null, stoppedByPanel: boolean }> }).entries
    const entry = entries.get('sick')!
    entry.status = 'stopped'
    entry.stoppedByPanel = true
    entry.lastError = 'stopped after 1 health restarts'
    expect(view(harness.supervisor, 'sick').stoppedByPanel, 'the fixture must start from a give-up').toBe(true)

    await harness.supervisor.start('sick')
    await waitFor(() => harness.supervisor.views().some(candidate => candidate.id === 'sick' && candidate.status === 'running'), 30000)
    expect(view(harness.supervisor, 'sick').stoppedByPanel, 'a start someone asked for ends the give-up').toBeUndefined()
  }, 60000)
})

/** A panel that gave up is a broken service; an operator's stop is not. */
describe('an entry the panel stopped', () => {
  it('reports stoppedByPanel for a give-up, and not for a stop someone asked for', async () => {
    const port = await freePort()
    const harness = await makeSupervisor([{
      id: 'sick',
      command: process.execPath,
      args: ['-e', 'require("node:http").createServer((q,s)=>{s.statusCode=500;s.end("no")}).listen(Number(process.env.PORT),"127.0.0.1")'],
      env: { PORT: '{port}' },
      port,
      health: { mode: 'http', intervalMs: 500, timeoutMs: 300, unhealthyThreshold: 1, forceRestartAfterMs: 400, startTimeoutMs: 5000 },
      restart: { enabled: true, maxRetries: 1, baseDelayMs: 30, factor: 1, maxDelayMs: 30, resetAfterMs: 600000 },
    }])

    await harness.supervisor.start('sick')
    await waitFor(() => view(harness.supervisor, 'sick').status === 'stopped', 45000)
    const givenUp = view(harness.supervisor, 'sick')
    expect(givenUp.stoppedByPanel, 'the panel must say it was the one that stopped it').toBe(true)

    // …and an operator's stop of a healthy entry is not that.
    const other = await makeSupervisor([{ id: 'fine', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }])
    await other.supervisor.start('fine')
    await other.supervisor.stop('fine')
    expect(view(other.supervisor, 'fine').stoppedByPanel).toBeUndefined()
  }, 60000)
})

/**
 * A stopped entry is not being probed, so it must not claim to be unhealthy — nor for how long.
 *
 * `stopEntry` cleared `health` and the failure count but left `unhealthySince` behind, so a server
 * stopped *because* it was unhealthy kept a growing duration beside a `Stopped` pill and a
 * `Not Probed` health row. Measured on the built panel: `status=stopped health=unknown
 * unhealthySince=<set>`, and the detail page read "Unhealthy for 1m 55s" until the timestamp was
 * fixed. The duration is the part that misleads: it keeps counting while nothing measures.
 */
describe('an explicit stop clears the health sequence it ends', () => {
  it('forgets when the entry became unhealthy', async () => {
    const port = await freePort()
    const harness = await makeSupervisor([{
      id: 'sickly',
      command: process.execPath,
      // Accepts TCP and answers 500 to every request: running, and never healthy.
      args: ['-e', 'require("node:http").createServer((q,s)=>{s.statusCode=500;s.end("no")}).listen(Number(process.env.PORT),"127.0.0.1")'],
      env: { PORT: '{port}' },
      port,
      health: { mode: 'http', intervalMs: 500, timeoutMs: 300, unhealthyThreshold: 1, forceRestartAfterMs: 0, startTimeoutMs: 5000 },
    }])

    const res = await harness.supervisor.start('sickly')
    expect(res.ok, `the fixture must actually start: ${res.error ?? ''}`).toBe(true)
    await waitFor(() => view(harness.supervisor, 'sickly').health === 'unhealthy', 20000)
    // The precondition, asserted rather than assumed: a fixture that never went unhealthy would
    // make the assertion below pass on a timestamp that was never set.
    expect(view(harness.supervisor, 'sickly').unhealthySince, 'the fixture never became unhealthy').not.toBeNull()

    await harness.supervisor.stop('sickly')

    const stopped = view(harness.supervisor, 'sickly')
    expect(stopped.status).toBe('stopped')
    expect(stopped.health).toBe('unknown')
    expect(stopped.unhealthySince, 'a stopped entry still claims how long it has been unhealthy').toBeNull()
  }, 60000)

  it('says "disabled" rather than "unknown" when the probe is switched off', async () => {
    const port = await freePort()
    const harness = await makeSupervisor([{
      id: 'unprobed',
      command: process.execPath,
      args: ['-e', 'require("node:http").createServer((q,s)=>s.end("ok")).listen(Number(process.env.PORT),"127.0.0.1")'],
      env: { PORT: '{port}' },
      port,
      health: { enabled: false },
    }])

    const res = await harness.supervisor.start('unprobed')
    expect(res.ok, `the fixture must actually start: ${res.error ?? ''}`).toBe(true)
    await harness.supervisor.stop('unprobed')
    expect(view(harness.supervisor, 'unprobed').health).toBe('disabled')
  }, 60000)
})

/**
 * A health streak belongs to one process, so an exit must end it — not only an explicit stop.
 *
 * Round 13 fixed the stop path; the exit paths reset `health` and kept `unhealthySince`, so an
 * entry that crashed *while* unhealthy reported `status=crashed health=unknown` beside a growing
 * `Unhealthy for 3m 17s` and a `Not Probed` row. Measured on the built panel with a service that
 * answered 500 and then exited: the duration kept counting while nothing was measured, on the card
 * whose own health row said nothing was being probed. Both surfaces render it from this one field.
 */
describe('an exit clears the health streak of the process it ends', () => {
  it('forgets when the entry became unhealthy when the process exits', async () => {
    const port = await freePort()
    const harness = await makeSupervisor([{
      id: 'sickly',
      command: process.execPath,
      // Accepts TCP and answers 500, so it goes unhealthy and stays up until the test ends it.
      args: ['-e', 'require("node:http").createServer((q,s)=>{s.statusCode=500;s.end("no")}).listen(Number(process.env.PORT),"127.0.0.1")'],
      env: { PORT: '{port}' },
      port,
      health: { mode: 'http', intervalMs: 500, timeoutMs: 300, unhealthyThreshold: 1, forceRestartAfterMs: 0, startTimeoutMs: 5000 },
      restart: { enabled: false, maxRetries: 0, baseDelayMs: 50, factor: 1, maxDelayMs: 50, resetAfterMs: 600000 },
    }])

    const res = await harness.supervisor.start('sickly')
    expect(res.ok, `the fixture must actually start: ${res.error ?? ''}`).toBe(true)
    await waitFor(() => view(harness.supervisor, 'sickly').unhealthySince !== null, 20000)
    // Asserted, not assumed: a fixture that never went unhealthy cannot prove the clearing.
    expect(view(harness.supervisor, 'sickly').health).toBe('unhealthy')

    // The exit is driven from here rather than by a timer inside the child: a fixed delay races the
    // first probe, and on a slower platform (measured on Windows) the child was gone before it was
    // ever recorded unhealthy, so the precondition never held and the case failed for the wrong
    // reason. Killing a process this panel spawned is the same `handleExit` path.
    const pid = view(harness.supervisor, 'sickly').pid
    expect(pid, 'the fixture must be running for its exit to be driven').not.toBeNull()
    process.kill(pid!, 'SIGTERM')

    await waitForStatus(harness.supervisor, 'sickly', 'crashed')
    const crashed = view(harness.supervisor, 'sickly')
    expect(crashed.health, 'a crashed entry is not being probed').toBe('unknown')
    expect(crashed.unhealthySince, 'a crashed entry still claims how long it has been unhealthy').toBeNull()
  }, 60000)
})
