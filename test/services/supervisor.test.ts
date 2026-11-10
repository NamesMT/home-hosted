import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectDir } from '#src/helpers/paths'
import { entryStatePath, readEntryState, writeEntryState } from '#src/providers/entry-state'
import { buildControlView, buildWorkspaceView } from '#src/services/state'
import { outputFiles } from '#src/services/supervisor/output'
import { needsAttention } from '#src/shared/server-attention'
import { cleanups, freePort, httpServerConfig, isAlive, makeSupervisor, portAccepts, runCleanups, scratchDir, view, waitFor, waitForStatus } from '../support/supervisor-harness'

afterEach(runCleanups)

describe('supervisor', () => {
  it('starts a configured server, reports it running, then stops it and frees the port', async () => {
    const port = await freePort()
    const { supervisor } = await makeSupervisor([httpServerConfig(port)])

    const result = await supervisor.start('web')
    expect(result.ok, `start failed: ${result.error}`).toBe(true)

    await waitForStatus(supervisor, 'web', 'running')
    expect(await portAccepts(port)).toBe(true)
    expect(view(supervisor, 'web').pid).toBeGreaterThan(0)
    expect(view(supervisor, 'web').url).toBe(`http://127.0.0.1:${port}`)
    expect(view(supervisor, 'web').portState).toBe('in-use')

    const pid = view(supervisor, 'web').pid!
    await supervisor.stop('web')

    expect(view(supervisor, 'web').status).toBe('stopped')
    expect(view(supervisor, 'web').pid).toBeNull()
    await waitFor(() => !isAlive(pid))
    await waitFor(async () => !(await portAccepts(port)))
  })

  /**
   * A restored dump loads on the entry's next start, not during the restore.
   *
   * `mongorestore` and `pg_restore` connect to a server, and a restore runs while the entry is
   * stopped — so the hook has to wait for the process. The demo is what caught this: the inline
   * version failed with "connection refused" and the database stayed empty.
   */
  /**
   * Two starts must not load the same dump twice.
   *
   * `pendingLoad` is cleared only after the readiness wait, which is long enough for a second `start`
   * to arrive and run the hook again — restoring data twice over a database being served.
   */
  it('loads a staged dump once, even when start is called twice', async () => {
    const port = await freePort()
    const dir = await scratchDir('hh-load2-')
    const marker = path.join(dir, 'runs.txt')
    const dumpDir = await scratchDir('hh-dump2-')
    await fs.promises.writeFile(path.join(dumpDir, 'db.archive'), 'X')

    const { supervisor } = await makeSupervisor([{
      ...httpServerConfig(port),
      load: {
        command: process.execPath,
        args: ['-e', `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "run\\n")`, '{dumpDir}'],
        timeoutMs: 10_000,
      },
    }])

    supervisor.stagePendingLoad('web', dumpDir)
    await Promise.all([supervisor.start('web'), supervisor.start('web')])
    await waitFor(() => fs.existsSync(marker), 15_000)
    await new Promise(resolve => setTimeout(resolve, 1500))

    const runs = fs.readFileSync(marker, 'utf8').trim().split('\n').length
    expect(runs, 'the dump must load exactly once').toBe(1)
  })

  /**
   * A restore that finishes while the entry is already up still loads.
   *
   * This is the autostart case: the restore's reload starts the entry, so by the time the dump is
   * recorded there is no later `start` to trigger it. Without the kick, a real migration restored an
   * empty database and never loaded it.
   */
  it('loads a dump staged while the entry is already running', async () => {
    const port = await freePort()
    const dir = await scratchDir('hh-load4-')
    const marker = path.join(dir, 'loaded.txt')
    const dumpDir = await scratchDir('hh-dump4-')
    await fs.promises.writeFile(path.join(dumpDir, 'db.archive'), 'LATE')

    const { supervisor } = await makeSupervisor([{
      ...httpServerConfig(port),
      load: {
        command: process.execPath,
        args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, require("node:fs").readFileSync(process.argv[1] + "/db.archive", "utf8"))`, '{dumpDir}'],
        timeoutMs: 10_000,
      },
    }])

    await supervisor.start('web')
    await waitForStatus(supervisor, 'web', 'running')
    // Staged *after* it is up, which is the order a restore with autostart produces.
    supervisor.stagePendingLoad('web', dumpDir)

    await waitFor(() => fs.existsSync(marker), 15_000)
    expect(fs.readFileSync(marker, 'utf8')).toBe('LATE')
  })

  /**
   * A staged dump whose entry has no `load` hook is dropped, not kept forever.
   *
   * Reachable from the plain restore UI: selecting only the workspace settings restores the config
   * without the hook, so the staged path would sit in the state file and be retried on every start.
   */
  it('drops a staged dump when the entry has no load hook', async () => {
    const port = await freePort()
    const dumpDir = await scratchDir('hh-dump3-')
    const { supervisor } = await makeSupervisor([httpServerConfig(port)])

    supervisor.stagePendingLoad('web', dumpDir)
    await supervisor.start('web')
    await waitFor(() => supervisor.logLines('web').some(entry => entry.text.includes('load:')), 10_000)
    await new Promise(resolve => setTimeout(resolve, 500))

    // A second start must not re-announce a load that can never run.
    const staged = supervisor.logLines('web').filter(entry => entry.text.includes('a restored dump is waiting')).length
    expect(staged, 'the pending load must be cleared once it is known it cannot run').toBe(1)
  })

  /**
   * A stop before the port answers keeps the dump staged instead of loading into nothing.
   *
   * The readiness wait ended on `stopped` and then ran the hook anyway, against a dead server, after
   * clearing `pendingLoad` — so the restored data was never loaded.
   */
  it('keeps a staged dump when the entry stops before it is ready', async () => {
    const port = await freePort()
    const marker = path.join(await scratchDir('hh-load5-'), 'loaded.txt')
    const dumpDir = await scratchDir('hh-dump5-')
    const { supervisor } = await makeSupervisor([{
      ...httpServerConfig(port),
      // Binds only after 2 s, so the stop lands while the load is still waiting.
      args: ['-e', 'setTimeout(()=>require("node:http").createServer((q,s)=>s.end("ok")).listen(Number(process.env.PORT),"127.0.0.1"),2000)'],
      load: {
        command: process.execPath,
        args: ['-e', `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "run\\n")`, '{dumpDir}'],
        timeoutMs: 10_000,
      },
    }])

    supervisor.stagePendingLoad('web', dumpDir)
    await supervisor.start('web')
    await new Promise(resolve => setTimeout(resolve, 300))
    await supervisor.stop('web')
    await waitFor(() => supervisor.logLines('web').some(line => line.text.includes('waits for the next start')), 10_000)
    expect(fs.existsSync(marker), 'no load may run against a stopped server').toBe(false)

    // Still staged: the next start loads it once the port answers.
    await supervisor.start('web')
    await waitFor(() => fs.existsSync(marker), 15_000)
    expect(fs.readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('runs a staged load once the entry is up, and clears it', async () => {
    const port = await freePort()
    const marker = path.join(await scratchDir('hh-load-'), 'loaded.txt')
    const dumpDir = await scratchDir('hh-dump-')
    await fs.promises.writeFile(path.join(dumpDir, 'db.archive'), 'FROM-DUMP')

    const { supervisor } = await makeSupervisor([{
      ...httpServerConfig(port),
      load: {
        command: process.execPath,
        args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, require("node:fs").readFileSync(process.argv[1] + "/db.archive", "utf8"))`, '{dumpDir}'],
        timeoutMs: 10_000,
      },
    }])

    supervisor.stagePendingLoad('web', dumpDir)
    expect(view(supervisor, 'web').status).toBe('stopped')

    await supervisor.start('web')
    await waitFor(() => fs.existsSync(marker), 15_000)
    expect(fs.readFileSync(marker, 'utf8')).toBe('FROM-DUMP')

    // Cleared, so a restart does not replay a dump over data written since.
    await waitFor(() => supervisor.logLines('web').some(entry => entry.text.includes('load: the restored dump was applied')), 15_000)
  })

  it('restarts a crashed server with exponential backoff and gives up after maxRetries', async () => {
    const { supervisor } = await makeSupervisor([{
      id: 'boom',
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      restart: { maxRetries: 2, baseDelayMs: 50, factor: 2, maxDelayMs: 200, resetAfterMs: 60000 },
      health: { enabled: false },
    }])

    await supervisor.start('boom')
    await waitFor(() => view(supervisor, 'boom').status === 'crashed')

    const crashed = view(supervisor, 'boom')
    expect(crashed.restarts).toBe(2)
    expect(crashed.exitCode).toBe(3)
    expect(crashed.lastError).toContain('gave up after 2 retries')

    const lines = supervisor.logLines('boom').map(entry => entry.text)
    expect(lines.some(text => text.includes('restart 1/2 in 50ms'))).toBe(true)
    expect(lines.some(text => text.includes('restart 2/2 in 100ms'))).toBe(true)
  })

  /**
   * The crash budget is reset by a start someone asked for, which is why no series carrying it may
   * be named `_total`.
   *
   * `hh_server_restarts_total` was published as a counter while this reset made it fall (`2` → `0`,
   * measured), so `rate()` saw a phantom counter reset each time an operator touched the entry. The
   * series is `hh_server_restarts` now; this pins the fact that forced the rename, at the level
   * that owns the value, so a later "make it monotonic" cannot land without failing here.
   */
  it('resets the crash-sequence budget when a start someone asked for ends the sequence', async () => {
    const { supervisor } = await makeSupervisor([{
      id: 'boom',
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      restart: { maxRetries: 2, baseDelayMs: 50, factor: 2, maxDelayMs: 200, resetAfterMs: 60000 },
      health: { enabled: false },
    }])

    await supervisor.start('boom')
    await waitFor(() => view(supervisor, 'boom').status === 'crashed')
    expect(view(supervisor, 'boom').restarts, 'the crash sequence spent its budget').toBe(2)

    // A click on Start, not a retry: `Supervisor.start()` resets the budget for an actor that is
    // not the panel's own policy. It is a new sequence, so the value goes down.
    await supervisor.start('boom', { actor: 'user' })
    expect(view(supervisor, 'boom').restarts, 'a start someone asked for begins a new sequence').toBe(0)
  })

  /**
   * An argument that expands from the environment must not reach the log.
   *
   * `resolveSpawn` expands `args` for the child but keeps `loggedArgs` pre-expansion, and that is
   * the whole reason the two exist: `${API_TOKEN}` in an argv would otherwise land in the ring
   * buffer, the rotated files, the SSE frames and any Telegram notice — four durable places, one of
   * them off this machine. The rule was a comment and nothing else, so this pins it.
   */
  it('logs the placeholder, never the value it expands to', async () => {
    let cleanupEnvFile: string | null = null
    const secret = 'super-secret-token-value'
    // The token must come from the *expansion* source, not the entry's own `env`. `expansionVars` is
    // `process.env` plus the env file — an entry's `config.env` is not consulted when expanding its
    // own argv, so declaring it there would leave the placeholder literal and prove nothing.
    const envFile = path.join(os.tmpdir(), `hh-leaky-${Date.now()}.env`)
    await fs.promises.writeFile(envFile, `LEAKY_TOKEN=${secret}\n`)
    const { supervisor, logDir, logFiles } = await makeSupervisor([{
      id: 'leaky',
      command: process.execPath,
      // eslint-disable-next-line no-template-curly-in-string -- the literal placeholder is the point
      args: ['-e', 'setTimeout(() => {}, 250)', '${LEAKY_TOKEN}'],
      envFile,
    }])
    cleanupEnvFile = envFile

    await supervisor.start('leaky')
    await waitForStatus(supervisor, 'leaky', 'running')

    const lines = supervisor.logLines('leaky').map(entry => entry.text).join('\n')
    // The literal placeholder is expected when the value is unavailable — but here it IS available
    // from the env file, so the assertion that matters is simply that the value never appears.
    expect(lines, 'the expanded secret must never be logged').not.toContain(secret)

    // And not in the *log* it writes, which is the durable copy that leaves this machine. The
    // config file is where the value is declared, so it naturally holds it — not asserted here.
    // Lines are buffered, so flush before reading rather than racing the interval.
    logFiles.flush()
    const written = (fs.existsSync(logDir) ? fs.readdirSync(logDir) : []).map(name => path.join(logDir, name))
    expect(written.length, 'the entry should have written a log').toBeGreaterThan(0)
    for (const file of written) {
      const content = fs.readFileSync(file, 'utf8')
      expect(content, `${path.basename(file)} must not carry the secret`).not.toContain(secret)
    }

    await supervisor.dispose()
    if (cleanupEnvFile !== null)
      fs.rmSync(cleanupEnvFile, { force: true })
  })

  it('keeps the spawn error when a command cannot be started', async () => {
    const { supervisor } = await makeSupervisor([{
      id: 'missing',
      command: 'definitely-not-a-real-command-xyz',
      args: [],
      restart: { enabled: true, maxRetries: 1, baseDelayMs: 50, factor: 2 },
    }])

    await supervisor.start('missing')
    await waitForStatus(supervisor, 'missing', 'crashed')

    const error = view(supervisor, 'missing').lastError ?? ''
    expect(error).not.toContain('code null')
    expect(error).toMatch(/ENOENT|not found|no such file/i)
    expect(supervisor.logLines('missing').some(line => line.text.includes('did not start'))).toBe(true)
  })

  it('stops an already-stopped server without wedging it', async () => {
    const { supervisor } = await makeSupervisor([{
      id: 'web',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      health: { enabled: false },
    }])

    expect(view(supervisor, 'web').status).toBe('stopped')
    expect(await supervisor.stop('web')).toEqual({ ok: true })

    // The stop cleared nothing, so it must not have left the entry stopping: a
    // `stopping` flag that is never reset makes every later start a 409.
    const started = await supervisor.start('web')
    expect(started.ok, `start failed: ${started.error}`).toBe(true)
    await waitForStatus(supervisor, 'web', 'running')

    expect((await supervisor.restart('web')).ok).toBe(true)
    await waitForStatus(supervisor, 'web', 'running')
  })

  it('does not restart when automatic restart is disabled', async () => {
    const { supervisor } = await makeSupervisor([{
      id: 'once',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      restart: { enabled: false },
      health: { enabled: false },
    }])

    await supervisor.start('once')
    await waitFor(() => view(supervisor, 'once').status === 'crashed')
    expect(view(supervisor, 'once').restarts).toBe(0)
    expect(view(supervisor, 'once').lastError).toContain('automatic restart disabled')
  })

  it('blocks a start when the port is already taken and onPortConflict is block', async () => {
    const port = await freePort()
    const squatter = net.createServer()
    await new Promise<void>(resolve => squatter.listen(port, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>(resolve => squatter.close(() => resolve())))

    const { supervisor } = await makeSupervisor([httpServerConfig(port, { onPortConflict: 'block' })])
    const result = await supervisor.start('web')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('already in use')
    expect(view(supervisor, 'web').status).toBe('conflict')
  })

  /**
   * A squatter must be a *separate* process: a listener inside the test process is
   * deliberately ignored by `listPortHolders`, so it could never be a holder.
   */
  async function squatterOn(port: number): Promise<number> {
    const child = spawn(process.execPath, ['-e', 'require("node:net").createServer().listen(Number(process.env.PORT),"127.0.0.1")'], {
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    })
    const pid = child.pid
    if (pid === undefined)
      throw new Error('could not spawn the squatter')

    cleanups.push(() => {
      try {
        process.kill(pid, 'SIGKILL')
      }
      catch {
        // already gone
      }
    })

    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if (await portAccepts(port))
        return pid
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`the squatter never took port ${port}`)
  }

  it('frees a port held by a foreign process, and clears the conflict', async () => {
    const port = await freePort()
    const squatter = await squatterOn(port)
    const { supervisor } = await makeSupervisor([httpServerConfig(port, { onPortConflict: 'block' })])

    const blocked = await supervisor.start('web')
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toContain(`port ${port} is already in use`)
    expect(blocked.error).toContain(`pid ${squatter}`)
    expect(view(supervisor, 'web').status).toBe('conflict')

    const freed = await supervisor.freePort('web')
    expect(freed.ok).toBe(true)
    expect(freed.free).toBe(true)
    expect(freed.terminated).toContain(squatter)
    expect(freed.skipped).toEqual([])

    // The entry is no longer blocked, and can start again.
    const after = view(supervisor, 'web')
    expect(after.status).toBe('stopped')
    expect(after.lastError).toBeNull()
    expect(after.portState).toBe('free')
    expect(supervisor.logLines('web').some(line => line.text.includes(`port ${port} is free`))).toBe(true)
  })

  it('refuses to kill a port held by a server this panel supervises', async () => {
    const port = await freePort()
    const { supervisor } = await makeSupervisor([
      httpServerConfig(port, { id: 'owner' }),
      httpServerConfig(port, { id: 'twin', onPortConflict: 'block' }),
    ])

    await supervisor.start('owner')
    await waitForStatus(supervisor, 'owner', 'running')

    const result = await supervisor.freePort('twin')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('supervises')
    expect(result.skipped.length).toBeGreaterThan(0)
    // The sibling is untouched, which is the whole point of the refusal.
    expect(view(supervisor, 'owner').status).toBe('running')
  })

  it('kills a foreign holder when the policy says so, then starts', async () => {
    const port = await freePort()
    const squatter = await squatterOn(port)
    const { supervisor } = await makeSupervisor([httpServerConfig(port, { onPortConflict: 'kill' })])

    const result = await supervisor.start('web')
    expect(result.ok).toBe(true)
    await waitForStatus(supervisor, 'web', 'running')

    await waitFor(() => !isAlive(squatter))
    expect(isAlive(squatter)).toBe(false)
    expect(supervisor.logLines('web').some(line => line.text.includes(`held by pid ${squatter}`) && line.text.includes('onPortConflict: kill'))).toBe(true)
  })

  it('will not kill a port held by a server this panel supervises, even under `kill`', async () => {
    const port = await freePort()
    const { supervisor } = await makeSupervisor([
      httpServerConfig(port, { id: 'owner' }),
      httpServerConfig(port, { id: 'twin', onPortConflict: 'kill' }),
    ])

    await supervisor.start('owner')
    await waitForStatus(supervisor, 'owner', 'running')

    const blocked = await supervisor.start('twin')
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toContain('which this panel supervises')
    // The sibling is untouched: a supervised holder is a config mistake, not a target.
    expect(view(supervisor, 'owner').status).toBe('running')
    expect(view(supervisor, 'twin').status).toBe('conflict')
  })

  /**
   * The refusal names the server to stop, not only the pid that holds the port.
   *
   * Measured on the built panel with 14 entries: `port 7101 is held by pid 135113, which this panel
   * supervises — stop that server instead`. True, and not actionable: nothing in the sentence says
   * which of the 14 rows to stop, and the person reading it is on one workspace page. The
   * attribution comes from the same tree walk that decided the holder was ours, so a wrapper's
   * descendant is credited to the entry that owns it.
   */
  it('names the server that owns a supervised port holder', async () => {
    const port = await freePort()
    const { supervisor } = await makeSupervisor([
      httpServerConfig(port, { id: 'owner' }),
      httpServerConfig(port, { id: 'twin' }),
    ])

    await supervisor.start('owner')
    await waitForStatus(supervisor, 'owner', 'running')

    const blocked = await supervisor.start('twin')
    expect(blocked.ok).toBe(false)
    expect(blocked.error, 'the sentence must name the entry to stop').toContain('/owner')
    // And it must not name the entry that is asking, which would send the person in a circle.
    expect(blocked.error).not.toContain('/twin')

    const freed = await supervisor.freePort('twin')
    expect(freed.ok).toBe(false)
    expect(freed.error, 'free-port says the same thing').toContain('/owner')
  })

  it('says so when there is nothing to free', async () => {
    const port = await freePort()
    const { supervisor } = await makeSupervisor([httpServerConfig(port, { onPortConflict: 'block' })])

    const missing = await supervisor.freePort('nope')
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('unknown server')

    const idle = await supervisor.freePort('web')
    expect(idle.ok).toBe(false)
    expect(idle.error).toContain(`nothing is listening on port ${port}`)
  })

  /**
   * The bootstrap schema accepts an empty `command` (as does the editor, gated only on
   * the block being enabled), and a command `spawn` cannot use is reported rather than
   * escaping `start()`: a rejection there lands after `status` was already `starting`,
   * wedging the entry with no pid until a daemon restart.
   *
   * How the failure surfaces is platform-specific — Linux throws synchronously from
   * `spawn`, macOS and Windows report it on the child's `error` event — so this pins
   * the behaviour that must hold on every platform: the start resolves and the entry
   * really comes up.
   */
  it('reports a bootstrap that cannot spawn, and still starts the server', async () => {
    const port = await freePort()
    const { supervisor } = await makeSupervisor([httpServerConfig(port, {
      bootstrap: { command: '', args: [], timeoutMs: 5000 },
    })])

    const result = await supervisor.start('web')
    expect(result.ok).toBe(true)
    await waitForStatus(supervisor, 'web', 'running')

    const lines = supervisor.logLines('web').map(entry => entry.text)
    expect(lines.some(text => text.includes('bootstrap could not start') || text.includes('bootstrap failed'))).toBe(true)
    // The entry is genuinely up, not merely reported as such.
    expect(view(supervisor, 'web').pid).not.toBeNull()
  })

  /** A NUL byte is the other command `spawn` refuses outright. */
  it('survives a bootstrap command that is unusable, not only an empty one', async () => {
    const port = await freePort()
    const { supervisor } = await makeSupervisor([httpServerConfig(port, {
      bootstrap: { command: 'node\0evil', args: [], timeoutMs: 5000 },
    })])

    const result = await supervisor.start('web')
    expect(result.ok).toBe(true)
    await waitForStatus(supervisor, 'web', 'running')
    expect(view(supervisor, 'web').status).toBe('running')
  })

  /** A program that is not there never ran: a `runOnce` bootstrap stays owed instead of being marked done. */
  it('does not mark a run-once bootstrap done when its program cannot be spawned', async () => {
    const port = await freePort()
    const { supervisor, nannyDir } = await makeSupervisor([httpServerConfig(port, {
      bootstrap: { command: 'hh-no-such-program-xyz', args: [], timeoutMs: 5000, runOnce: true },
    })])

    expect((await supervisor.start('web')).ok).toBe(true)
    await waitForStatus(supervisor, 'web', 'running')
    expect(readEntryState(entryStatePath(nannyDir, 'web'))?.bootstrapDone ?? false).toBe(false)
  })

  /** A stop mid-bootstrap ends what the bootstrap started, not only the shell that started it. */
  it.skipIf(process.platform === 'win32')('a stop during the bootstrap kills its grandchildren too', async () => {
    const dir = await scratchDir('hh-boot-tree-')
    const pidFile = path.join(dir, 'grandchild.pid')
    cleanups.push(() => {
      try {
        process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL')
      }
      catch {
        // Never written, or already gone.
      }
    })
    const { supervisor } = await makeSupervisor([{
      id: 'w',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      health: { enabled: false },
      restart: { enabled: false },
      bootstrap: { command: 'sh', args: ['-c', `sleep 30 & echo $! > ${pidFile}; wait`], timeoutMs: 20000, runOnce: false },
    }])

    const starting = supervisor.start('w')
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim().length > 0)
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'))
    await supervisor.stop('w')
    await starting
    await waitFor(() => !isAlive(grandchild), 3000)
  })

  it('runs bootstrap once, streams its output, and then starts the server', async () => {
    const port = await freePort()
    const { supervisor } = await makeSupervisor([httpServerConfig(port, {
      bootstrap: {
        command: process.execPath,
        args: ['-e', 'console.log("bootstrapped")'],
        timeoutMs: 10000,
      },
    })])

    await supervisor.start('web')
    await waitFor(() => view(supervisor, 'web').status === 'running')

    const lines = supervisor.logLines('web').map(entry => entry.text)
    expect(lines.some(text => text.includes('bootstrap: '))).toBe(true)
    expect(lines.some(text => text.includes('[bootstrap] bootstrapped'))).toBe(true)

    // runOnce: a manual restart must not bootstrap again
    await supervisor.restart('web')
    await waitFor(() => view(supervisor, 'web').status === 'running')
    const afterRestart = supervisor.logLines('web').filter(entry => entry.text.includes('[bootstrap]'))
    expect(afterRestart).toHaveLength(1)
  })

  /** Each stream is its own byte sequence: a half-written stdout line must not absorb stderr's. */
  it('keeps a bootstrap\'s stdout and stderr partial lines apart', async () => {
    const port = await freePort()
    const script = [
      'const wait = ms => new Promise(resolve => setTimeout(resolve, ms))',
      ';(async () => {',
      '  process.stdout.write("out-"); await wait(100)',
      '  process.stderr.write("err-"); await wait(100)',
      '  process.stdout.write("A\\n"); await wait(100)',
      '  process.stderr.write("B\\n"); await wait(100)',
      '  process.stdout.write("tail-without-newline")',
      '})()',
    ].join('\n')
    const { supervisor } = await makeSupervisor([httpServerConfig(port, {
      bootstrap: { command: process.execPath, args: ['-e', script], timeoutMs: 10000 },
    })])

    await supervisor.start('web')
    await waitFor(() => view(supervisor, 'web').status === 'running')

    const lines = supervisor.logLines('web').map(entry => entry.text).filter(text => text.startsWith('[bootstrap]'))
    expect(lines).toEqual(['[bootstrap] out-A', '[bootstrap] err-B', '[bootstrap] tail-without-newline'])
  })

  it('exports data envs to the process, over `env`', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-dataenv-'))
    cleanups.push(() => fs.promises.rm(dir, { recursive: true, force: true }))
    const out = path.join(dir, 'env.json')

    const { supervisor } = await makeSupervisor([{
      id: 'web',
      command: process.execPath,
      args: ['-e', `require("node:fs").writeFileSync(process.env.OUT, JSON.stringify({ data: process.env.APP_DATA, port: process.env.PORT }))`],
      env: { OUT: out, PORT: '1', APP_DATA: 'ignored' },
      dataEnvs: { APP_DATA: '{projectDir}/data' },
      port: null,
      restart: { enabled: false },
    }])

    await supervisor.start('web')
    await waitFor(() => fs.existsSync(out))
    const written = JSON.parse(fs.readFileSync(out, 'utf8')) as { data: string, port: string }
    expect(written.data).toBe(path.join(projectDir, 'data'))
    expect(written.port).toBe('1')
  })

  it('kills the whole process tree on stop when killGroup is set', async () => {
    const port = await freePort()
    const { supervisor } = await makeSupervisor([{
      id: 'tree',
      command: process.execPath,
      args: ['-e', 'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); require("node:http").createServer((q,s)=>s.end("ok")).listen(Number(process.env.PORT),"127.0.0.1")'],
      env: { PORT: '{port}' },
      port,
      health: { intervalMs: 500, timeoutMs: 500, unhealthyThreshold: 2, forceRestartAfterMs: 0, startTimeoutMs: 8000 },
      stop: { killGroup: true, graceMs: 1000 },
    }])

    await supervisor.start('tree')
    await waitForStatus(supervisor, 'tree', 'running')
    const pid = view(supervisor, 'tree').pid!

    await supervisor.stop('tree')
    await waitFor(() => !isAlive(pid))
    expect(view(supervisor, 'tree').status).toBe('stopped')
  })

  it('exposes config and state through the control and workspace views', async () => {
    const port = await freePort()
    const { supervisor, store, settings, auth, control, tls, notifications, ddns, logDir } = await makeSupervisor([httpServerConfig(port)])

    const controlView = buildControlView(settings, auth, control, tls)
    expect(controlView.port).toBe(3999)

    const workspace = buildWorkspaceView({
      id: 'default',
      label: 'default',
      store,
      logsDir: logDir,
      notifications,
      ddns,
      supervisor,
    })
    expect(workspace.configPath).toBe(store.path)
    expect(workspace.servers).toHaveLength(1)
    expect(workspace.servers[0]?.status).toBe('stopped')
    expect(workspace.configError).toBeNull()
  })

  it('adds and removes runtime entries when the config changes on disk', async () => {
    const port = await freePort()
    const { supervisor, store } = await makeSupervisor([httpServerConfig(port)])

    store.addServer({ id: 'extra', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] })
    await waitFor(() => supervisor.views().some(entry => entry.id === 'extra'))

    store.removeServer('extra')
    await waitFor(() => !supervisor.views().some(entry => entry.id === 'extra'))
  })
  it('follows a detached restart of itself instead of reporting a conflict', async () => {
    // dsh (via its market plugin) restarts by spawning a new detached process and
    // exiting. The old panel saw a busy port and blocked forever while the service
    // was actually running; with onPortConflict adopt it takes the successor over.
    const port = await freePort()
    const { supervisor } = await makeSupervisor([httpServerConfig(port, { onPortConflict: 'follow' })])

    const successor = spawn(process.execPath, [
      '-e',
      'require("node:http").createServer((q,s)=>s.end("ok")).listen(Number(process.env.PORT),"127.0.0.1")',
    ], {
      env: { ...process.env, PORT: String(port), HHOSTED_SERVER_ID: 'web' },
      stdio: 'ignore',
    })
    const successorPid = successor.pid
    if (successorPid === undefined)
      throw new Error('no successor pid')
    cleanups.push(() => {
      try {
        process.kill(successorPid, 'SIGKILL')
      }
      catch {
        // already gone
      }
    })
    while (!(await portAccepts(port)))
      await new Promise(resolve => setTimeout(resolve, 50))

    const result = await supervisor.start('web')
    expect(result.ok).toBe(true)

    const adopted = view(supervisor, 'web')
    expect(adopted.status).toBe('running')
    expect(adopted.pid).toBe(successorPid)
    expect(adopted.adopted).toBe(true)
    expect(adopted.lastError).toBeNull()
    expect(supervisor.logLines('web').some(line => line.text.includes('adopted pid'))).toBe(true)

    // Adopted or not, the panel still owns stopping it.
    await supervisor.stop('web')
    await waitFor(() => !isAlive(successorPid))
    const stopped = view(supervisor, 'web')
    expect(stopped.status).toBe('stopped')
    expect(stopped.adopted).toBeUndefined()
    expect(stopped.pid).toBeNull()
  })

  /**
   * A stopped entry must not keep the measurements of the process it stopped.
   *
   * `responseMs` and `resources` belong to one run. A child we spawned has an exit event, and
   * both exit paths clear them; an **adopted** successor has no exit event — the stop is the only
   * path that ends it — so the numbers outlived the process. Measured on the built panel with a
   * real adopted successor: `stopped` + `health=unknown` beside `Probe 2 Ms`, `RSS 64.2 MB`,
   * `Procs 1`, and `/api/metrics` still publishing `hh_server_cpu_percent` for it.
   */
  it('drops the measurements of an adopted successor when it is stopped', async () => {
    const port = await freePort()
    const { supervisor } = await makeSupervisor([httpServerConfig(port, { onPortConflict: 'follow' })])

    const successor = spawn(process.execPath, httpServerConfig(port).args as string[], {
      env: { ...process.env, PORT: String(port), HHOSTED_SERVER_ID: 'web' },
      stdio: 'ignore',
    })
    const successorPid = successor.pid
    if (successorPid === undefined)
      throw new Error('no successor pid')
    cleanups.push(() => {
      try {
        process.kill(successorPid, 'SIGKILL')
      }
      catch {
        // already gone
      }
    })
    while (!(await portAccepts(port)))
      await new Promise(resolve => setTimeout(resolve, 50))

    await supervisor.start('web')
    // The precondition, asserted so a fixture that never sampled cannot pass vacuously: the panel
    // has to have a real reading before the stop is asked to forget one.
    await waitFor(() => {
      const live = view(supervisor, 'web')
      return live.resources !== null && live.responseMs !== null ? live : undefined
    }, 15000)
    const live = view(supervisor, 'web')
    expect(live.adopted).toBe(true)
    expect(live.responseMs, 'the probe must have reported a latency before the stop').not.toBeNull()

    await supervisor.stop('web')
    await waitFor(() => !isAlive(successorPid))

    const stopped = view(supervisor, 'web')
    expect(stopped.status).toBe('stopped')
    expect(stopped.pid).toBeNull()
    expect(stopped.responseMs, 'a stopped entry must not keep the probe latency of the process it stopped').toBeNull()
    expect(stopped.resources, 'a stopped entry must not keep the CPU and RSS of the process it stopped').toBeNull()
  })

  /**
   * The memory ceiling must fire on an **adopted** process, which is the one case it silently
   * skipped.
   *
   * `enforceMemoryLimit` required `entry.child !== null`, and an adopted successor has no child
   * of ours — `adoptEntry` and the persistent reattach both leave it null. So `follow` adopted a
   * leaking server and `resources.maxRssBytes` never acted on it, while the same entry under
   * `reclaim` (a child we spawned) would have restarted. Measured on the built panel: an adopted
   * successor holding 148 MB beside a 40 MB ceiling stayed `running` with `restarts: 0` for the
   * whole observation. The other half is that sampling already measures an adopted entry
   * (`child !== null || adopted`), so the reading was there and only the action was missing.
   */
  it('restarts an adopted successor that exceeds its memory ceiling', async () => {
    const port = await freePort()
    // The entry declares the very script its successor runs: on Windows a successor is recognised
    // by its command line (another process's environment is unreadable there), so a different
    // `-e` script was simply never adopted.
    const hog = 'const hold = []; for (let i = 0; i < 64; i++) hold.push(Buffer.alloc(1024 * 1024, i));'
      + 'require("node:http").createServer((q,s)=>s.end("ok")).listen(Number(process.env.PORT),"127.0.0.1")'
    const harness = await makeSupervisor([httpServerConfig(port, {
      args: ['-e', hog],
      onPortConflict: 'follow',
      // Above the plain node process this spawns, far below what it holds below.
      resources: { maxRssBytes: 8 * 1024 * 1024 },
      restart: { maxRetries: 3, baseDelayMs: 50, factor: 2, maxDelayMs: 200, resetAfterMs: 60000 },
    })])

    const sent: string[] = []
    const original = harness.notifications.notify.bind(harness.notifications)
    vi.spyOn(harness.notifications, 'notify').mockImplementation((event) => {
      sent.push(event.reason)
      original(event)
    })

    // A real successor of this entry that holds ~64 MB: the reading has to be genuinely over the
    // limit, so a fixture that never allocated cannot pass this by accident.
    const successor = spawn(process.execPath, ['-e', hog], {
      env: { ...process.env, PORT: String(port), HHOSTED_SERVER_ID: 'web' },
      stdio: 'ignore',
    })
    const successorPid = successor.pid
    if (successorPid === undefined)
      throw new Error('no successor pid')
    cleanups.push(() => {
      try {
        process.kill(successorPid, 'SIGKILL')
      }
      catch {
        // already gone
      }
    })
    while (!(await portAccepts(port)))
      await new Promise(resolve => setTimeout(resolve, 50))

    await harness.supervisor.start('web')
    // The precondition, so a fixture that was never adopted cannot prove anything: this is the
    // entry the ceiling used to skip.
    expect(view(harness.supervisor, 'web').adopted).toBe(true)

    await waitFor(() => sent.includes('rss'), 40000)
    const logged = harness.supervisor.logLines('web').map(line => line.text).join('\n')
    expect(logged, 'the message must name what was measured').toContain('process tree use')
    // Restarting is the action, not just the sentence: the adopted successor is replaced by a
    // process of our own, which is what `restart()` does here too.
    await waitFor(() => view(harness.supervisor, 'web').pid !== successorPid, 20000)
  }, 120000)

  // macOS cannot answer this one: its argv reading goes through `ps -o command=`, which
  // joins the arguments with spaces and quotes none of them, so this entry's `-e` script
  // (which contains spaces) cannot be told from several arguments. That case blocks by
  // design rather than matching loosely; the marker path above still covers macOS.
  it.skipIf(process.platform === 'darwin')('follows a detached restart that lost the environment marker, by its argv', async () => {
    // The Windows shape: no per-process environment to read, so the entry's own argv is
    // all the panel has. Same adoption, without the marker that made it easy.
    const port = await freePort()
    const { supervisor } = await makeSupervisor([httpServerConfig(port, { onPortConflict: 'follow' })])

    const env: Record<string, string> = { ...process.env, PORT: String(port) }
    delete env.HHOSTED_SERVER_ID
    const successor = spawn(process.execPath, httpServerConfig(port).args as string[], { env, stdio: 'ignore' })
    const successorPid = successor.pid
    if (successorPid === undefined)
      throw new Error('no successor pid')
    cleanups.push(() => {
      try {
        process.kill(successorPid, 'SIGKILL')
      }
      catch {
        // already gone
      }
    })
    while (!(await portAccepts(port)))
      await new Promise(resolve => setTimeout(resolve, 50))

    const result = await supervisor.start('web')
    expect(result.ok).toBe(true)

    const adopted = view(supervisor, 'web')
    expect(adopted.status).toBe('running')
    expect(adopted.pid).toBe(successorPid)
    expect(adopted.adopted).toBe(true)
  })

  it('blocks on a stranger under the follow policy too', async () => {
    const port = await freePort()
    const squatter = await squatterOn(port)
    const { supervisor } = await makeSupervisor([httpServerConfig(port, { onPortConflict: 'follow' })])

    const result = await supervisor.start('web')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('already in use')
    // Not ours, so nothing is adopted and nothing is started over it.
    expect(view(supervisor, 'web').status).toBe('conflict')
    expect(view(supervisor, 'web').adopted).toBeUndefined()
    expect(isAlive(squatter)).toBe(true)
  })

  it('starts its own process again once an adopted one exits', async () => {
    const port = await freePort()
    const { supervisor } = await makeSupervisor([httpServerConfig(port, { onPortConflict: 'follow' })])

    const successor = spawn(process.execPath, [
      '-e',
      'require("node:http").createServer((q,s)=>s.end("ok")).listen(Number(process.env.PORT),"127.0.0.1")',
    ], {
      env: { ...process.env, PORT: String(port), HHOSTED_SERVER_ID: 'web' },
      stdio: 'ignore',
    })
    const successorPid = successor.pid
    if (successorPid === undefined)
      throw new Error('no successor pid')
    cleanups.push(() => {
      try {
        process.kill(successorPid, 'SIGKILL')
      }
      catch {
        // already gone
      }
    })
    while (!(await portAccepts(port)))
      await new Promise(resolve => setTimeout(resolve, 50))

    await supervisor.start('web')
    expect(view(supervisor, 'web').adopted).toBe(true)

    // The successor dies on its own: the tick notices and the normal lifecycle resumes.
    process.kill(successorPid, 'SIGKILL')
    await waitFor(() => {
      const current = view(supervisor, 'web')
      return current.status === 'running' && current.adopted !== true && current.pid !== successorPid && current.pid !== null
    }, 20000)
    expect(await portAccepts(port)).toBe(true)
  })

  it('stops an adopted successor when the entry is disabled', async () => {
    // An adopted successor has no child of ours, which `isActive()` used to read as
    // "nothing running" — so disabling the entry left the process serving.
    const port = await freePort()
    const { supervisor, store } = await makeSupervisor([httpServerConfig(port, { onPortConflict: 'follow' })])

    const successor = spawn(process.execPath, [
      '-e',
      'require("node:http").createServer((q,s)=>s.end("ok")).listen(Number(process.env.PORT),"127.0.0.1")',
    ], {
      env: { ...process.env, PORT: String(port), HHOSTED_SERVER_ID: 'web' },
      stdio: 'ignore',
    })
    const successorPid = successor.pid
    if (successorPid === undefined)
      throw new Error('no successor pid')
    cleanups.push(() => {
      try {
        process.kill(successorPid, 'SIGKILL')
      }
      catch {
        // already gone
      }
    })
    while (!(await portAccepts(port)))
      await new Promise(resolve => setTimeout(resolve, 50))

    await supervisor.start('web')
    expect(view(supervisor, 'web').adopted).toBe(true)

    store.updateServer('web', { enabled: false })
    await waitFor(() => !isAlive(successorPid), 20000)
    expect(isAlive(successorPid)).toBe(false)
  })

  it('reclaims the port from a detached successor, for a fully supervised process', async () => {
    // The other half of the choice: following a successor costs its output, because
    // the pipe belongs to whoever spawned it. Reclaiming kills it and starts a child
    // of our own, so logs, resources and stop all work the normal way.
    const port = await freePort()
    const { supervisor } = await makeSupervisor([httpServerConfig(port, { onPortConflict: 'reclaim' })])

    const successor = spawn(process.execPath, [
      '-e',
      'require("node:http").createServer((q,s)=>s.end("ok")).listen(Number(process.env.PORT),"127.0.0.1")',
    ], {
      env: { ...process.env, PORT: String(port), HHOSTED_SERVER_ID: 'web' },
      stdio: 'ignore',
    })
    const successorPid = successor.pid
    if (successorPid === undefined)
      throw new Error('no successor pid')
    cleanups.push(() => {
      try {
        process.kill(successorPid, 'SIGKILL')
      }
      catch {
        // already gone
      }
    })
    while (!(await portAccepts(port)))
      await new Promise(resolve => setTimeout(resolve, 50))

    const result = await supervisor.start('web')
    expect(result.ok).toBe(true)
    // Reclaiming spawns a child of our own, so it becomes ready asynchronously.
    await waitForStatus(supervisor, 'web', 'running')

    const current = view(supervisor, 'web')
    expect(current.adopted).toBeUndefined()
    expect(current.pid).not.toBe(successorPid)
    // The successor was replaced, not followed.
    await waitFor(() => !isAlive(successorPid))
    expect(supervisor.logLines('web').some(line => line.text.includes('replacing it with a supervised process'))).toBe(true)

    await supervisor.stop('web')
  })

  it('treats our own detached successor like `reclaim` under `kill`, not like `block`', async () => {
    // `kill` skips the ownership question, so it does not need the HHOSTED_SERVER_ID
    // marker at all — but the outcome for a successor is `reclaim`'s (stopped and
    // replaced by a supervised child), never `block`'s.
    const port = await freePort()
    const { supervisor } = await makeSupervisor([httpServerConfig(port, { onPortConflict: 'kill' })])

    const successor = spawn(process.execPath, [
      '-e',
      'require("node:http").createServer((q,s)=>s.end("ok")).listen(Number(process.env.PORT),"127.0.0.1")',
    ], {
      env: { ...process.env, PORT: String(port), HHOSTED_SERVER_ID: 'web' },
      stdio: 'ignore',
    })
    const successorPid = successor.pid
    if (successorPid === undefined)
      throw new Error('no successor pid')
    cleanups.push(() => {
      try {
        process.kill(successorPid, 'SIGKILL')
      }
      catch {
        // already gone
      }
    })
    while (!(await portAccepts(port)))
      await new Promise(resolve => setTimeout(resolve, 50))

    const result = await supervisor.start('web')
    expect(result.ok).toBe(true)
    await waitForStatus(supervisor, 'web', 'running')

    const current = view(supervisor, 'web')
    expect(current.adopted).toBeUndefined()
    expect(current.pid).not.toBe(successorPid)
    await waitFor(() => !isAlive(successorPid))
    expect(supervisor.logLines('web').some(line => line.text.includes('onPortConflict: kill'))).toBe(true)

    await supervisor.stop('web')
  })

  it('keeps publishing state for an idle server, so the charts get samples', async () => {
    // Regression: the state signature held only structural fields, so a fleet where
    // nothing moved emitted no frames at all. The UI builds its telemetry by sampling
    // those frames, so every graph stayed empty until a server was poked into
    // changing something.
    //
    // The supervisor no longer builds the aggregate frame — the panel does, and it
    // dedupes on a signature that includes `resources.sampledAt`. What this pins is
    // the supervisor's half of that contract: for an idle running server it keeps
    // signalling the panel and keeps handing over a fresh resource sample, so the
    // panel's signature does move and a frame is emitted.
    const harness = await makeSupervisor([{
      id: 'idle',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      health: { enabled: false },
    }])
    const { supervisor } = harness

    await supervisor.start('idle')
    await waitForStatus(supervisor, 'idle', 'running')
    const signalsAtStart = harness.stateChanges()

    const sampledAt: number[] = []
    // Resources are sampled every 5 s; two distinct samples prove they keep moving.
    const deadline = Date.now() + 14000
    while (new Set(sampledAt.filter(value => value > 0)).size < 2 && Date.now() < deadline) {
      sampledAt.push(view(supervisor, 'idle').resources?.sampledAt ?? 0)
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    const distinct = new Set(sampledAt.filter(value => value > 0))
    expect(distinct.size).toBeGreaterThanOrEqual(2)
    // The panel is told at every tick, not only when something structural changed.
    expect(harness.stateChanges()).toBeGreaterThan(signalsAtStart)
    // Nothing structural moved to earn those samples.
    expect(view(supervisor, 'idle').status).toBe('running')
    expect(view(supervisor, 'idle').health).toBe('disabled')
  })

  /**
   * A live store outlives its supervisor — `PanelService.remove()` disposes a workspace's
   * supervisor and only then drops the runtime — so a discarded `onChange` unsubscribe
   * leaves the disposed supervisor, its entries and its ring buffers reachable for the
   * rest of the session, and its `sync()` still runs on every later store change.
   */
  it('detaches from the store when disposed', async () => {
    const harness = await makeSupervisor([])
    const { supervisor, store } = harness

    const attached = store.listenerCount
    expect(attached).toBeGreaterThan(0)

    await supervisor.dispose()
    expect(store.listenerCount).toBe(attached - 1)
  })

  /**
   * A force restart was announced and then never closed: the restart resets health to
   * `unknown`, so the `unhealthy -> healthy` transition that sends `recovered` never
   * happened. "It restarted and is fine" and "it restarted and is broken" therefore read
   * the same in a chat until the next crash.
   */
  it('announces that a force-restarted entry came back, not only that it restarted', async () => {
    const port = await freePort()
    // Listens, then drops the listener while staying alive: the health probe starts
    // failing, which is what makes the supervisor force a restart. On the restart it
    // listens again, so the outcome is "serving again".
    const harness = await makeSupervisor([{
      id: 'flaky',
      command: process.execPath,
      args: ['-e', 'const s=require("node:http").createServer((q,r)=>r.end("ok")); s.listen(Number(process.env.PORT),"127.0.0.1"); setTimeout(()=>s.close(),700); setInterval(()=>{},1000)'],
      env: { PORT: '{port}' },
      port,
      health: { intervalMs: 500, timeoutMs: 300, unhealthyThreshold: 1, forceRestartAfterMs: 100, startTimeoutMs: 8000 },
      restart: { maxRetries: 3, baseDelayMs: 50, factor: 2, maxDelayMs: 200, resetAfterMs: 60000 },
    }])
    const { supervisor, notifications } = harness

    const sent: string[] = []
    const original = notifications.notify.bind(notifications)
    vi.spyOn(notifications, 'notify').mockImplementation((event) => {
      sent.push(event.reason)
      original(event)
    })

    await supervisor.start('flaky')
    await waitForStatus(supervisor, 'flaky', 'running')

    await waitFor(() => sent.includes('forced-restart'), 30000)
    // …and then the outcome, once it is serving again.
    await waitFor(() => sent.includes('restart-ok'), 30000)
    expect(sent.filter(reason => reason === 'restart-ok')).toHaveLength(1)
  })
})

/**
 * A non-persistent child is spawned detached, so it survives the panel being killed hard
 * while nothing but its own state file remembers it. `preflight` cannot cover a portless
 * entry — it returns `free` immediately — so a second panel booted over the same state
 * spawned a **second copy** of a bot or queue consumer that was still running. These pin
 * the record that closes that hole, and the refusal that replaces guessing.
 */
describe('a non-persistent child that outlived the panel', () => {
  const code = 'require("node:fs").appendFileSync(process.env.PID_FILE, process.pid + "\\n"); setInterval(() => {}, 1000)'

  function portlessConfig(pidFile: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'worker',
      command: process.execPath,
      args: ['-e', code],
      env: { PID_FILE: pidFile },
      port: null,
      autostart: true,
      restart: { enabled: false },
      health: { enabled: false },
      ...overrides,
    }
  }

  /** Every pid the entry itself recorded in its file, in order. */
  function recordedPids(pidFile: string): number[] {
    if (!fs.existsSync(pidFile))
      return []
    return fs.readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number)
  }

  /**
   * Kills the named pids when the test ends.
   *
   * Pushed *after* the harness's own cleanup, so reverse-order unwinding runs it first —
   * while the shared state directory still exists. Reading the pid file in the cleanup
   * itself would be too late for a test with a second harness, and a detached child that
   * is never killed outlives the whole run.
   */
  function cleanupPids(pids: number[]): void {
    cleanups.push(() => {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL')
        }
        catch {
          // Already gone.
        }
      }
    })
  }

  it('adopts the child recorded in its state file instead of spawning a duplicate', async () => {
    const harness = await makeSupervisor([])
    const pidFile = path.join(harness.dir, 'pids.txt')
    const servers = [portlessConfig(pidFile)]
    // The entry arrives after the first panel is up, the way a config edit adds one.
    harness.store.addServer(servers[0] as never)

    await harness.supervisor.startAll({ autostartOnly: true })
    // Readiness for a portless entry is assumed on spawn, so the child's own first write
    // is what proves it is really up.
    await waitFor(() => recordedPids(pidFile).length === 1 ? true : undefined)
    const firstPid = view(harness.supervisor, 'worker').pid!
    cleanupPids([firstPid])
    expect(recordedPids(pidFile)).toEqual([firstPid])

    // The panel dies hard: no `dispose()`, no stop, so the detached child keeps running
    // and the only trace is the state file written when it was spawned.
    const state = readEntryState(entryStatePath(harness.nannyDir, 'worker'))
    expect(state?.lastPid, 'the spawned child must be recorded for a later boot to find').toBe(firstPid)
    expect(isAlive(firstPid)).toBe(true)

    // A second panel boots over the same state directory.
    const second = await makeSupervisor(servers, undefined, harness.dir)
    await second.supervisor.startAll({ autostartOnly: true })

    // Settle on whichever outcome this platform reaches: on Linux and macOS the survivor is
    // verified by its `HHOSTED_SERVER_ID` marker and adopted; on Windows that marker is
    // unreadable, so the entry is refused rather than duplicated. Both are the same promise —
    // one process, never a second copy — reached two ways.
    const after = await waitFor(() => {
      const current = view(second.supervisor, 'worker')
      // Only a settled outcome counts. A refusal is settled immediately (`conflict`, no pid);
      // an adoption is settled once it is running. Anything else — still starting — is not.
      if (current.status !== 'running' && current.status !== 'conflict')
        return undefined
      // An adopted survivor writes nothing new, so a panel that spawned its own child is given
      // the moment that child needs to announce itself; until then the duplicate is simply not
      // in the file yet. A refusal spawns nothing, so there is no pid to wait for.
      if (current.status === 'running' && current.pid !== firstPid && recordedPids(pidFile).length < 2)
        return undefined
      return current
    }, 5000)

    // The whole point, asserted on the pids themselves so a regression here names both:
    // exactly one process for this entry, never a second copy beside the survivor. This part
    // is platform-independent — a refusal satisfies it exactly as an adoption does.
    const pids = recordedPids(pidFile)
    expect(pids, `a duplicate was spawned: ${JSON.stringify(pids)}`).toEqual([firstPid])
    expect(pids.filter(isAlive), `expected only ${firstPid} alive, got ${JSON.stringify(pids)}`).toEqual([firstPid])
    expect(after.pid === null || after.pid === firstPid, 'never a pid beside the survivor').toBe(true)

    if (process.platform === 'linux' || process.platform === 'darwin') {
      expect(after.pid, 'the second panel must adopt the survivor, not spawn beside it').toBe(firstPid)
      expect(after.adopted).toBe(true)
      expect(second.supervisor.logLines('worker').some(line => line.text.includes(`adopted pid ${firstPid}`) && line.text.includes('before it died'))).toBe(true)
    }
    else {
      // Where the marker cannot be read, refusing is the safe half of the same guarantee: it
      // names the pid instead of starting a twin, and keeps the record so a retry cannot
      // silently turn into a duplicate.
      expect(after.status).toBe('conflict')
      expect(after.adopted, '`adopted` is only present when true').toBeUndefined()
      expect(after.lastError).toContain(`pid ${firstPid}`)
      expect(second.supervisor.logLines('worker').some(line => line.text.includes('not starting a second copy'))).toBe(true)
    }
  })

  it('starts normally when the recorded pid is stale', async () => {
    const harness = await makeSupervisor([])
    const pidFile = path.join(harness.dir, 'pids.txt')
    // The record is written before the entry exists, which is how a boot reads one.
    writeEntryState(entryStatePath(harness.nannyDir, 'worker'), {
      restarts: 0,
      bootstrapDone: true,
      lastPid: 999_999,
      lastStartedAt: Date.now(),
    })
    harness.store.addServer(portlessConfig(pidFile) as never)

    await harness.supervisor.startAll({ autostartOnly: true })
    await waitForStatus(harness.supervisor, 'worker', 'running')

    const current = view(harness.supervisor, 'worker')
    expect(current.adopted).toBeUndefined()
    expect(current.pid).not.toBe(999_999)
    await waitFor(() => recordedPids(pidFile).length === 1 ? true : undefined)
    cleanupPids([current.pid!])
    expect(recordedPids(pidFile)).toEqual([current.pid])
  })

  /**
   * The safety case: a recorded pid that is alive but is *not* this entry. Adopting it
   * would hand the entry somebody else's process — and stopping the entry would then kill
   * it — so a pid the marker rejects is never adopted. With no port there is no second
   * witness, so the start is refused rather than turned into a duplicate.
   */
  it('does not adopt a live pid that is not this entry', async () => {
    // A live process that is not this entry: a sibling server the panel started.
    const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: { ...process.env, HHOSTED_SERVER_ID: 'someone-else' },
      stdio: 'ignore',
    })
    const siblingPid = sibling.pid!
    cleanups.push(() => {
      try {
        process.kill(siblingPid, 'SIGKILL')
      }
      catch {
        // Already gone.
      }
    })

    const harness = await makeSupervisor([])
    const pidFile = path.join(harness.dir, 'pids.txt')
    writeEntryState(entryStatePath(harness.nannyDir, 'worker'), {
      restarts: 0,
      bootstrapDone: true,
      lastPid: siblingPid,
      lastStartedAt: Date.now(),
    })
    harness.store.addServer(portlessConfig(pidFile) as never)

    await harness.supervisor.startAll({ autostartOnly: true })
    const result = view(harness.supervisor, 'worker')

    expect(result.adopted, 'a stranger must never be adopted as this entry').toBeUndefined()
    expect(result.pid, 'and no child of our own may be started beside it').toBeNull()
    if (process.platform === 'linux' || process.platform === 'darwin') {
      // Where the marker is readable this is a verified "not ours": refuse, and say so.
      expect(result.status).toBe('conflict')
      expect(result.lastError).toContain(`pid ${siblingPid}`)
      expect(harness.supervisor.logLines('worker').some(line => line.text.includes('not starting a second copy'))).toBe(true)
    }
    // The stranger is untouched, whatever the entry then did.
    expect(isAlive(siblingPid)).toBe(true)
    // Nothing was spawned for the entry, so its file never gains a pid.
    expect(recordedPids(pidFile)).toEqual([])
  })

  it('clears the recorded child once it has exited, so a later boot does not chase it', async () => {
    const harness = await makeSupervisor([])
    const pidFile = path.join(harness.dir, 'pids.txt')
    harness.store.addServer(portlessConfig(pidFile) as never)

    await harness.supervisor.startAll({ autostartOnly: true })
    await waitFor(() => recordedPids(pidFile).length === 1 ? true : undefined)
    const pid = view(harness.supervisor, 'worker').pid!
    expect(readEntryState(entryStatePath(harness.nannyDir, 'worker'))?.lastPid).toBe(pid)

    // A graceful stop ends the child, so the record must go with it: pids are recycled,
    // and a pid left behind is a later boot adopting a stranger.
    await harness.supervisor.stop('worker')
    await waitFor(() => !isAlive(pid))
    await waitFor(() => readEntryState(entryStatePath(harness.nannyDir, 'worker'))?.lastPid === null ? true : undefined)
    expect(readEntryState(entryStatePath(harness.nannyDir, 'worker'))?.lastPid).toBeNull()
  })
})

/**
 * Removing a server must reclaim its log files.
 *
 * They used to stay: `sync()` deleted the entry and unfollowed the relay, and only the explicit
 * `DELETE /api/logs/:id` route ever called `logFiles.clear`. Two consequences, and the second is the
 * one that bites — the files accumulate for every server a panel has ever run, and **re-adding an id**
 * (a rename-back, a config edit, a restore) made `readTail` serve the previous server's lines as if
 * they were the new one's, because nothing distinguishes a stale file from a current one.
 */
describe('a removed server', () => {
  it('takes its log files with it, so a re-added id starts clean', async () => {
    const harness = await makeSupervisor([{ id: 'web', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }])
    const { supervisor, store, logFiles, history } = harness

    // A crash the removed entry is known for, so its disappearance is measurable.
    history.record('web', { type: 'crash', detail: 'THE OLD ENTRY' })
    expect(history.summarize('web', 86_400_000).lastCrashAt).not.toBeNull()

    await supervisor.start('web')
    await waitFor(() => view(supervisor, 'web').status === 'running')
    supervisor.logLines('web') // touch the buffer so the entry is live
    logFiles.append('web', { ts: 1, stream: 'stdout', text: 'HISTORY OF THE OLD ENTRY' })
    logFiles.flush()
    expect((await logFiles.readTail('web', 10)).some(line => line.text.includes('HISTORY OF THE OLD ENTRY'))).toBe(true)

    // Drop it the way a config edit does: the store stops listing the id, then syncs.
    store.removeServer('web')
    await waitFor(() => supervisor.views().length === 0)

    expect(
      (await logFiles.readTail('web', 10)).some(line => line.text.includes('HISTORY OF THE OLD ENTRY')),
      'the removed entry\'s log lines must not survive to be served under the same id',
    ).toBe(false)
    // The same reclaim for history: otherwise the card reports "Last crash" for a server that was
    // never started. Asserted here too, because `forget` in the removal branch is its own wiring.
    expect(history.summarize('web', 86_400_000).lastCrashAt, 'nor its crash history').toBeNull()
  })

  /**
   * The transport files go with the entry too.
   *
   * A child's raw output is written to `.state/<id>.out`/`.err` and read back into the log. They are
   * a third per-id artifact, and the removal branch is a list — a new one that is not added leaves
   * files behind for an id that no longer exists, and a re-added id would start with a dead run's
   * bytes still on disk.
   */
  it('takes the transport output files with it', async () => {
    const harness = await makeSupervisor([{ id: 'web', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }])
    const { supervisor, store, nannyDir } = harness

    await supervisor.start('web')
    await waitFor(() => view(supervisor, 'web').status === 'running')
    const files = outputFiles(nannyDir, 'web')
    expect(fs.existsSync(files.stdout), 'the running entry has its transport files').toBe(true)

    store.removeServer('web')
    await waitFor(() => supervisor.views().length === 0)
    // The stop that follows the removal clears them; give it its moment.
    await waitFor(() => !fs.existsSync(files.stdout) ? true : undefined)
    expect(fs.existsSync(files.stderr)).toBe(false)
  })

  /**
   * The removal reclaims the entry's state file, and the stop that follows is asynchronous: the
   * child's `exit` lands afterwards and reaches `forgetRecordedChild`. Writing there put the file
   * back — stale state for a re-added id, and a file appearing while a caller walks the directory
   * to delete it, which is what surfaced as a flaky `ENOTEMPTY` in the harness teardown.
   */
  it('does not let the exit that follows put its state file back', async () => {
    const harness = await makeSupervisor([{ id: 'web', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }])
    const { supervisor, store, nannyDir } = harness
    const statePath = entryStatePath(nannyDir, 'web')

    await supervisor.start('web')
    await waitFor(() => view(supervisor, 'web').status === 'running')
    await waitFor(() => fs.existsSync(statePath) ? true : undefined)

    store.removeServer('web')
    await waitFor(() => supervisor.views().length === 0)
    // Past the child's exit, which is the window the late write landed in.
    await new Promise(resolve => setTimeout(resolve, 1500))

    expect(fs.existsSync(statePath), 'a removed entry must not have its state file resurrected').toBe(false)
  })
})

/**
 * A process the panel started that no entry claims any more has to be visible.
 *
 * The handle is the entry-state file keyed by the id the child was started under. Rename the entry
 * after a hard panel death and nothing reads that file again; remove the entry while the panel is
 * down and `sync` reclaims it. Either way the child keeps running with no card, no `/healthz` line
 * and no CLI action — and for a queue consumer that is two consumers of one queue, the most
 * damaging duplicate this tool can produce.
 */
describe('orphaned processes', () => {
  it('reports a live child whose entry no longer exists', async () => {
    const harness = await makeSupervisor([])
    const { supervisor, nannyDir } = harness

    // A child that is genuinely alive, recorded under an id the config does not have.
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true })
    child.unref()
    try {
      writeEntryState(entryStatePath(nannyDir, 'renamed-away'), {
        restarts: 0,
        bootstrapDone: false,
        lastPid: child.pid ?? null,
        lastStartedAt: Date.now(),
      })

      // The list is refreshed by the tick; call the same path the view reads after one refresh.
      await (supervisor as unknown as { refreshOrphans: (n?: number) => Promise<void> }).refreshOrphans()
      expect(supervisor.orphans()).toContainEqual({
        serverId: 'renamed-away',
        pid: child.pid,
        startedAt: expect.any(Number),
      })
    }
    finally {
      if (child.pid !== undefined)
        process.kill(child.pid, 'SIGKILL')
    }
  })

  it('stops a reported orphan and reclaims its record', async () => {
    const harness = await makeSupervisor([])
    const { supervisor, nannyDir } = harness

    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true })
    child.unref()
    const pid = child.pid!
    const statePath = entryStatePath(nannyDir, 'stray')
    writeEntryState(statePath, { restarts: 0, bootstrapDone: false, lastPid: pid, lastStartedAt: Date.now() })

    try {
      expect(await supervisor.stopOrphan('stray')).toEqual({ ok: true })
      await waitFor(() => !isAlive(pid))
      // The handle is only cleared once the process is known gone, so a survivor stays findable.
      expect(fs.existsSync(statePath)).toBe(false)
      expect(supervisor.orphans()).toEqual([])
    }
    finally {
      if (isAlive(pid))
        process.kill(pid, 'SIGKILL')
    }
  })

  it('refuses an id that is not an orphan', async () => {
    const harness = await makeSupervisor([])
    const result = await harness.supervisor.stopOrphan('nothing')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no orphaned process')
  })

  /**
   * A recycled pid is somebody else's process, and must never be offered for stopping.
   *
   * The first version only checked liveness, so a pid the OS had recycled after a reboot matched a
   * stale record — the panel listed a stranger as an orphan and `stopOrphan` SIGTERMed it. The
   * project already owns the witness for this (`processLiveness` returns `'recycled'`).
   */
  it('never reports a pid the OS recycled to a different process', async () => {
    const harness = await makeSupervisor([])
    const { supervisor, nannyDir } = harness

    // Alive now, but the record claims it started an hour ago: it cannot be ours.
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true })
    child.unref()
    const pid = child.pid!
    writeEntryState(entryStatePath(nannyDir, 'recycled-name'), {
      restarts: 0,
      bootstrapDone: false,
      lastPid: pid,
      lastStartedAt: Date.now() - 3_600_000,
    })

    try {
      await (supervisor as unknown as { refreshOrphans: (n?: number) => Promise<void> }).refreshOrphans()
      expect(supervisor.orphans(), 'a recycled pid belongs to a stranger').toEqual([])
      // …and the action refuses it, rather than killing a process the panel never started.
      expect((await supervisor.stopOrphan('recycled-name')).ok).toBe(false)
      expect(isAlive(pid), 'the stranger must still be alive').toBe(true)
    }
    finally {
      if (isAlive(pid))
        process.kill(pid, 'SIGKILL')
    }
  })

  it('says nothing about a state file whose process is gone', async () => {
    const harness = await makeSupervisor([])
    const { supervisor, nannyDir } = harness

    // A pid that cannot be alive: the record outlived its process, which is the normal case.
    writeEntryState(entryStatePath(nannyDir, 'long-gone'), {
      restarts: 0,
      bootstrapDone: false,
      lastPid: 2 ** 22 + 12345,
      lastStartedAt: Date.now(),
    })

    await (supervisor as unknown as { refreshOrphans: (n?: number) => Promise<void> }).refreshOrphans()
    expect(supervisor.orphans()).toEqual([])
  })

  it('never reports an id a configured entry owns', async () => {
    const port = await freePort()
    // A real listener, so the entry reaches `running` and writes its state file.
    const harness = await makeSupervisor([httpServerConfig(port)])
    await harness.supervisor.start('web')
    await waitForStatus(harness.supervisor, 'web', 'running')

    // Its own state file is not an orphan: the entry that owns it is right here.
    await (harness.supervisor as unknown as { refreshOrphans: (n?: number) => Promise<void> }).refreshOrphans()
    expect(harness.supervisor.orphans()).toEqual([])
  })
})

/**
 * A child that was running when the panel died, and is not running when the next panel boots.
 *
 * It was reported as a **clean stop**: `resolveRecordedChild` saw `liveness: 'gone'` and answered
 * `{kind: 'none'}`, so the entry read `status: stopped`, `lastError: null`, `degraded: false`, no
 * `crash` event was recorded and the restart budget was untouched. That is the same silence the
 * persistent path already avoids ("exited while the panel was away"), and it is the half of the
 * liveness defect a person actually feels: the server they believe is supervised is gone, and
 * nothing anywhere says so.
 */
describe('a recorded child that is gone when the panel boots', () => {
  /** A recorded pid that nothing is behind: the shape of a child killed with the panel. */
  const DEAD_PID = 999_999

  function portless(pidFile: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'worker',
      command: process.execPath,
      args: ['-e', `require("node:fs").appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n"); setInterval(() => {}, 1000)`],
      port: null,
      restart: { enabled: false },
      health: { enabled: false },
      ...overrides,
    }
  }

  it('is a crash with a reason at boot, not a clean stop', async () => {
    const harness = await makeSupervisor([])
    const pidFile = path.join(harness.dir, 'pids.txt')
    writeEntryState(entryStatePath(harness.nannyDir, 'worker'), {
      restarts: 0,
      bootstrapDone: true,
      lastPid: DEAD_PID,
      lastStartedAt: Date.now() - 60_000,
    })
    // No `autostart`: this boot starts nothing, which is exactly the entry that reported nothing.
    harness.store.addServer(portless(pidFile) as never)

    await harness.supervisor.startAll({ autostartOnly: true })

    const events = harness.history.all().filter(event => event.serverId === 'worker')
    const crash = events.find(event => event.type === 'crash')
    expect(crash, 'the end of that run must be recorded as a crash').toBeDefined()
    expect(crash!.detail).toContain(String(DEAD_PID))
    // An exit too: history has to read as a run that ended, not as one that vanished.
    expect(events.some(event => event.type === 'exit')).toBe(true)
    // The reason is on the entry and in its log, and nothing was started for it.
    expect(harness.supervisor.logLines('worker').some(line => line.text.includes(String(DEAD_PID)))).toBe(true)
    // A non-autostart entry is not started, so its child never ran and its file was never written.
    expect(fs.existsSync(pidFile), 'nothing may be spawned for a non-autostart entry').toBe(false)

    // The surfaced half: `crashed` is what `/healthz` and the UIs read through `needsAttention`.
    // Left `stopped`, the panel answered `200 ok` with `degraded: false` about a server that is gone.
    const after = view(harness.supervisor, 'worker')
    expect(after.status, 'a run that ended while nobody watched is not a clean stop').toBe('crashed')
    expect(after.lastError).toContain('gone now')
    expect(needsAttention(after), 'the panel must count this as something to look at').toBe(true)
  })

  it('does not report it twice: the start that follows consumes the record', async () => {
    const harness = await makeSupervisor([])
    const pidFile = path.join(harness.dir, 'pids.txt')
    writeEntryState(entryStatePath(harness.nannyDir, 'worker'), {
      restarts: 0,
      bootstrapDone: true,
      lastPid: DEAD_PID,
      lastStartedAt: Date.now() - 60_000,
    })
    harness.store.addServer(portless(pidFile, { autostart: true }) as never)

    await harness.supervisor.startAll({ autostartOnly: true })
    await waitForStatus(harness.supervisor, 'worker', 'running')

    const crashes = harness.history.all().filter(event => event.serverId === 'worker' && event.type === 'crash')
    expect(crashes, 'one dead run is one crash, however many paths look at the record').toHaveLength(1)
    // The fresh start owns the card now: the crash's reason is not left describing it.
    expect(view(harness.supervisor, 'worker').lastError).toBeNull()
  })

  /**
   * The sweep is not the autostart's business.
   *
   * `up --no-autostart` starts nothing, so a sweep reachable only from `startAll()` never ran and the
   * card stayed `stopped` / `lastError: null` about a child that had died with the panel. Worse, the
   * Start a person then pressed entered `resolveRecordedChild`, which consumed the record and
   * reported with `reportAway: false` (their action is the news) — so the crash was lost outright
   * rather than merely delayed. Both halves are pinned here.
   */
  it('reports it on a boot that starts nothing, so a later Start cannot lose it', async () => {
    const harness = await makeSupervisor([])
    const pidFile = path.join(harness.dir, 'pids.txt')
    writeEntryState(entryStatePath(harness.nannyDir, 'worker'), {
      restarts: 0,
      bootstrapDone: true,
      lastPid: DEAD_PID,
      lastStartedAt: Date.now() - 60_000,
    })
    harness.store.addServer(portless(pidFile) as never)

    // Exactly what `runControlPlane` does for `--no-autostart`: sweep, and start nothing.
    await harness.supervisor.reportAwayChildren()
    expect(view(harness.supervisor, 'worker').status, 'a boot that starts nothing still reports the loss').toBe('crashed')
    expect(harness.history.all().filter(event => event.serverId === 'worker' && event.type === 'crash'))
      .toHaveLength(1)

    // The record was consumed by the sweep, so the Start that follows cannot report it a second time
    // (and cannot silently swallow it either, which is what happened when the sweep did not run).
    await harness.supervisor.start('worker')
    await waitForStatus(harness.supervisor, 'worker', 'running')
    expect(harness.history.all().filter(event => event.serverId === 'worker' && event.type === 'crash'))
      .toHaveLength(1)
  })

  it('reports nothing when the recorded pid belongs to a live process again', async () => {
    // A pid the OS recycled is not a crash of the run the record describes — it is not that run at
    // all. Recorded with a birth stamp *after* the process was born, which is `'recycled'`.
    const harness = await makeSupervisor([])
    const pidFile = path.join(harness.dir, 'pids.txt')
    writeEntryState(entryStatePath(harness.nannyDir, 'worker'), {
      restarts: 0,
      bootstrapDone: true,
      lastPid: process.pid,
      lastStartedAt: Date.now(),
    })
    harness.store.addServer(portless(pidFile) as never)

    await harness.supervisor.startAll({ autostartOnly: true })

    // The panel itself is never adopted or reported as a dead child of this entry.
    expect(harness.history.all().filter(event => event.serverId === 'worker')).toEqual([])
    expect(fs.existsSync(pidFile), 'and it must not spawn beside a live pid').toBe(false)
  })
})

/**
 * A NUL in an environment key must not stop the entry from starting.
 *
 * `spawn` **throws** on one — `must be a string without null bytes` — so the entry crashed with Node's
 * raw message naming an invisible character, and none of its other variables loaded. A NUL is reachable
 * from both sides: an `envFile` line (the parser takes the text before the first `=`, whatever it is)
 * and a JSON config, where `\u0000` is a legal escape.
 */
describe('an environment key with a null byte', () => {
  it('is dropped, and the rest of the environment still loads', async () => {
    // Built with `String.fromCharCode(0)` rather than written in the source: a literal NUL in a string
    // here is itself enough to make `spawn` refuse the args array, which is the defect under test.
    const NUL = String.fromCharCode(0)
    const harness = await makeSupervisor([{
      id: 'web',
      command: process.execPath,
      args: ['-e', 'console.log(JSON.stringify({ good: process.env.GOOD, nulls: Object.keys(process.env).filter(k => k.charCodeAt(0) === 0).length }))'],
      env: { GOOD: 'yes', [`ODD${NUL}KEY`]: 'would have crashed spawn' },
    }])

    const result = await harness.supervisor.start('web')
    expect(result.ok, `spawn must not throw: ${result.error ?? ''}`).toBe(true)
    await waitFor(() => harness.supervisor.logLines('web').some(line => line.text.includes('null byte')))
    // Its sibling variable is intact: dropping one key must not drop the layer.
    await waitFor(() => harness.supervisor.logLines('web').some(line => line.text.includes('"good":"yes"')))
    // And the child saw no NUL-keyed variable at all.
    await waitFor(() => harness.supervisor.logLines('web').some(line => line.text.includes('"nulls":0')))
  })
})

/**
 * The real server view must satisfy the contract the UIs and the OpenAPI spec publish.
 *
 * `test/api/fixture.ts` builds views by hand (`makeView`) with a cast, so nothing validated the **real**
 * `supervisor.view()` output against `serverViewSchema` — and the fixture's shape is missing fields the
 * contract requires, including `bindHost`. That is a fixture that cannot fail: it exercises the routes
 * against a payload the panel never sends.
 */
describe('the real server view', () => {
  it('satisfies serverViewSchema', async () => {
    const { serverViewSchema } = await import('#src/shared/contracts')
    const { type } = await import('arktype')
    const harness = await makeSupervisor([{ id: 'web', command: process.execPath, args: ['-e', 'null'] }])
    const view = harness.supervisor.views().find(entry => entry.id === 'web')
    expect(view, 'the supervisor must report the entry').toBeDefined()
    const parsed = serverViewSchema(view)
    expect(parsed instanceof type.errors, `real view violates its contract: ${String((parsed as { summary?: string }).summary)}`).toBe(false)
  })
})

/**
 * Every placeholder the code expands must be in the documented table, and vice versa.
 *
 * `AGENTS.md` listed eight while `serverTemplateVars` provided eleven — `{label}`, `{displayHost}` and
 * `{lanIp}` were missing, so an agent following the rules would not know they existed. It now points at
 * [`docs/SERVERS.md`](docs/SERVERS.md) instead of holding a copy, and this keeps that table honest.
 *
 * The direction that matters most is code → docs: a placeholder added to `serverTemplateVars` and left
 * undocumented is invisible unless someone reads the source.
 */
/**
 * Every field `serverSchema` accepts must be named in the field reference.
 *
 * `enabled` was the one exception — it governs whether an entry runs at all, and it appeared in
 * `docs/DDNS.md` and `docs/REVERSE_PROXY.md` for their own settings while the server field itself was
 * absent from the only table a person reads. Nothing compared the two lists.
 */
/**
 * Every entry the panel keeps under `.hh` must appear in the README's layout.
 *
 * `.proxy/` was missing: the reverse proxy's engine, its generated config and its state live there, and
 * the table is the one place a person looks to understand what the panel put on their disk. AGENTS.md
 * listed it, `docs/REVERSE_PROXY.md` names it three times, and the README — the entry point — did not.
 *
 * Read from `paths.ts` rather than from a copied list, so a new state directory cannot go unlisted.
 */
describe('the documented state layout', () => {
  it('names every top-level entry under .hh', () => {
    const paths = fs.readFileSync(fileURLToPath(new URL('../../src/helpers/paths.ts', import.meta.url)), 'utf8')
    const topLevel = new Set([...paths.matchAll(/path\.join\(hhDir,\s*'([^']+)'/g)].map(m => m[1]!))

    // Anti-vacuity: the list must actually carry the known entries.
    expect(topLevel.size, 'the hhDir joins must have been parsed').toBeGreaterThanOrEqual(8)
    expect(topLevel.has('settings.json')).toBe(true)

    const readme = fs.readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8')
    // Scoped to the layout table's own rows, not the whole document. A bare
    // `readme.includes(entry)` fallback made the check near-unfailable: a new state directory named
    // `logs` or `settings.json` matches README *prose* anywhere ("logs" appears 27 times), so an
    // entry the layout table never names still passed.
    const layoutRows = readme.split('\n').filter(line => line.includes('`.hh/') || line.includes('$HHOSTED_HOME/.hh'))
    const missing = [...topLevel].filter(entry =>
      !layoutRows.some(row => row.includes(entry)),
    )
    expect(missing, 'a state entry the layout table never mentions').toEqual([])
    // Anti-vacuity: the table must actually have been found, or `missing` is trivially empty.
    expect(layoutRows.length, 'no README layout rows matched').toBeGreaterThan(1)
  })
})

describe('the documented field reference', () => {
  it('names every field serverSchema accepts', () => {
    const contracts = fs.readFileSync(fileURLToPath(new URL('../../src/shared/contracts.ts', import.meta.url)), 'utf8')
    const start = contracts.indexOf('export const serverSchema = lazy(() => type({')
    // Bracket-match the object literal rather than guessing where it ends.
    let depth = 0
    let end = start
    for (let i = contracts.indexOf('{', start); i < contracts.length; i++) {
      if (contracts[i] === '{') {
        depth += 1
      }
      else if (contracts[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const fields = [...contracts.slice(start, end).matchAll(/^\s+'?(\w+)'?\s*:/gm)]
      .map(m => m[1]!)
      .filter(name => name !== 'return')

    // Anti-vacuity: the block must actually hold the known field set.
    expect(fields.length, 'serverSchema must have been parsed').toBeGreaterThanOrEqual(20)
    expect(fields).toContain('enabled')

    const doc = fs.readFileSync(fileURLToPath(new URL('../../docs/SERVERS.md', import.meta.url)), 'utf8')
    const missing = fields.filter(name => !doc.includes(name))
    expect(missing, 'a field the config accepts but the reference never names').toEqual([])
  })
})

describe('the documented placeholder table', () => {
  it('lists exactly what the code expands', async () => {
    const { serverTemplateVars } = await import('#src/services/supervisor')
    const provided = new Set(Object.keys(serverTemplateVars({
      id: 'web',
      command: 'node',
      label: 'Web',
      port: 4010,
      bind: 'local',
      cwd: '.',
    } as never)))

    // Anti-vacuity: the vars object must actually carry the known set.
    expect(provided.size).toBeGreaterThanOrEqual(11)
    expect(provided.has('id')).toBe(true)

    const doc = fs.readFileSync(fileURLToPath(new URL('../../docs/SERVERS.md', import.meta.url)), 'utf8')
    const documented = new Set([...doc.matchAll(/`\{(\w+)\}`/g)].map(m => m[1]))

    const undocumented = [...provided].filter(name => !documented.has(name))
    expect(undocumented, 'a placeholder the code expands but the docs never mention').toEqual([])
  })
})
