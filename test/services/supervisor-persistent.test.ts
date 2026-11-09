import type { NannyState } from '#src/shared/contracts'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nannySpecPath, nannyStatePath, readNannyState, writeNannySpec, writeNannyState } from '#src/providers/nanny'
import { armRealNannySpawn, cleanups, freePort, isAlive, makeSupervisor, portAccepts, runCleanups, scratchDir, view, waitFor, waitForStatus } from '../support/supervisor-harness'

afterEach(runCleanups)

/**
 * A persistent entry is run by a nanny process the panel spawns and then reattaches
 * to. These tests stand in for that nanny with a plain long-lived process: the panel's
 * whole job is to find it again through the state file and leave it alone.
 */
describe('persistent entries', () => {
  /** A long-lived process, cleaned up whatever the test does. */
  function spawnStub(): number {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    child.unref()
    const pid = child.pid!
    cleanups.push(() => {
      try {
        process.kill(pid, 'SIGKILL')
      }
      catch {
        // Already gone.
      }
    })
    return pid
  }

  /** A process that outlives the test's own supervisor, plus the state describing it. */
  async function fakeNanny(nannyDir: string, id: string, patch: Partial<NannyState> = {}): Promise<number> {
    const pid = spawnStub()
    writeNannyState(nannyStatePath(nannyDir, id), {
      serverId: id,
      nannyPid: pid,
      childPid: null,
      startedAt: Date.now(),
      logFile: '',
      heartbeatAt: Date.now(),
      ...patch,
    } as NannyState)
    return pid
  }

  function persistentConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'keep',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      persistent: true,
      autostart: false,
      ...overrides,
    }
  }

  /**
   * `--no-autostart` skips the reattach pass, and a hand edit can add a persistent entry
   * after boot, so the panel can hold an entry with no child and no pid while its nanny
   * and real server are still running. A stop must adopt it first — otherwise the early
   * return answers `stopped` and the server keeps serving behind that answer.
   */
  it('stops a live persistent entry the panel never attached to', async () => {
    const { supervisor, nannyDir } = await makeSupervisor([persistentConfig()])
    const pid = await fakeNanny(nannyDir, 'keep')

    // Deliberately no startAll: this is the `--no-autostart` boot.
    expect(view(supervisor, 'keep').pid).toBeNull()

    const result = await supervisor.stop('keep')
    expect(result.ok).toBe(true)

    expect(isAlive(pid)).toBe(false)
    expect(view(supervisor, 'keep').status).toBe('stopped')
    // The state file is consumed, so a later boot cannot reattach to a stopped entry.
    expect(readNannyState(nannyStatePath(nannyDir, 'keep'))).toBeNull()
  })

  it('reattaches to a running entry instead of starting a second copy', async () => {
    const { supervisor, nannyDir } = await makeSupervisor([persistentConfig()])
    const pid = await fakeNanny(nannyDir, 'keep')

    await supervisor.startAll({ autostartOnly: true })

    expect(view(supervisor, 'keep').status).toBe('running')
    expect(view(supervisor, 'keep').pid).toBe(pid)
    expect(supervisor.logLines('keep').some(line => line.text.includes('reattached'))).toBe(true)
    // Reattaching is not starting: an entry the panel was told to leave alone is
    // adopted because it is running, not because it was launched.
    expect(supervisor.logLines('keep').some(line => line.text.startsWith('start'))).toBe(false)
  })

  it('fills the live buffer from the log file when it reattaches', async () => {
    // A reattached entry writes nothing new on its own, so without this the Logs page's
    // live view stays blank until the server happens to print something.
    const { supervisor, nannyDir, logDir } = await makeSupervisor([persistentConfig()])
    await fakeNanny(nannyDir, 'keep')
    fs.mkdirSync(logDir, { recursive: true })
    const file = path.join(logDir, 'keep.log')
    for (const text of ['old one', 'old two', 'old three'])
      fs.appendFileSync(file, `${JSON.stringify({ ts: Date.now(), stream: 'stdout', text })}\n`)

    await supervisor.startAll({ autostartOnly: true })

    const texts = supervisor.logLines('keep').map(line => line.text)
    expect(texts.slice(0, 3)).toEqual(['old one', 'old two', 'old three'])
    // History first, the panel's own attach line last: the buffer stays in order.
    expect(texts[3]).toContain('reattached')
  })

  it('stops a persistent entry through stop-all when asked, leaving it otherwise', async () => {
    // The flag is the whole difference: one call leaves the nanny alone, the next ends it.
    const { supervisor, nannyDir } = await makeSupervisor([persistentConfig()])
    const pid = await fakeNanny(nannyDir, 'keep')
    await supervisor.startAll({ autostartOnly: true })

    await supervisor.stopAll({ withPersistent: true })
    expect(isAlive(pid)).toBe(false)
    expect(view(supervisor, 'keep').status).toBe('stopped')
    expect(readNannyState(nannyStatePath(nannyDir, 'keep'))).toBeNull()
  })

  it('leaves a persistent entry running through stop-all, and stops it explicitly', async () => {
    const { supervisor, nannyDir } = await makeSupervisor([persistentConfig()])
    const pid = await fakeNanny(nannyDir, 'keep')
    await supervisor.startAll({ autostartOnly: true })

    await supervisor.stopAll()
    expect(isAlive(pid)).toBe(true)
    expect(view(supervisor, 'keep').status).toBe('running')

    const result = await supervisor.stop('keep')
    expect(result.ok).toBe(true)
    expect(isAlive(pid)).toBe(false)
    expect(readNannyState(nannyStatePath(nannyDir, 'keep'))).toBeNull()
  })

  it('stops the child of a persistent entry even when the stop cannot be forwarded', async () => {
    // SIGKILL cannot be trapped, and `killGroup: false` signals the nanny's pid alone:
    // without reaching into the state file for the child, the panel would report
    // "stopped" while the server kept running and holding its port.
    const { supervisor, nannyDir } = await makeSupervisor([
      persistentConfig({ stop: { signal: 'SIGKILL', killGroup: false, graceMs: 1000, killPortHolders: false } }),
    ])
    const child = spawnStub()
    const pid = await fakeNanny(nannyDir, 'keep', { childPid: child })
    await supervisor.startAll({ autostartOnly: true })
    expect(view(supervisor, 'keep').pid).toBe(pid)

    const result = await supervisor.stop('keep')

    expect(result.ok).toBe(true)
    expect(isAlive(pid)).toBe(false)
    expect(isAlive(child)).toBe(false)
    expect(readNannyState(nannyStatePath(nannyDir, 'keep'))).toBeNull()
  })

  it('stops a persistent entry that was disabled while the panel was down', async () => {
    // Nobody will ever attach to it now, and an unadopted nanny is invisible to
    // `supervisedPids()` — a process this panel could later kill as a stranger.
    const { supervisor, nannyDir } = await makeSupervisor([persistentConfig({ enabled: false })])
    const pid = await fakeNanny(nannyDir, 'keep')

    await supervisor.startAll({ autostartOnly: true })

    await waitFor(() => isAlive(pid) ? undefined : true)
    expect(readNannyState(nannyStatePath(nannyDir, 'keep'))).toBeNull()
  })

  it('sweeps a spawn spec left behind by a panel that died before its nanny read it', async () => {
    let specPath = ''
    await makeSupervisor([persistentConfig()], (dir) => {
      specPath = nannySpecPath(path.join(dir, 'state'), 'keep')
      writeNannySpec(specPath, {
        serverId: 'keep',
        command: process.execPath,
        args: [],
        cwd: dir,
        env: { SECRET: 'expanded' },
        logDir: path.join(dir, 'logs'),
        logs: { persist: true, maxBytes: 1_000_000, keep: 3 },
        stop: { signal: 'SIGTERM', killGroup: true, graceMs: 1000, killPortHolders: false },
      })
    })

    expect(fs.existsSync(specPath)).toBe(false)
  })

  it('starts tailing the log when it adopts a persistent entry\'s successor', async () => {
    // The fallback path: the state file is gone, so `follow` takes the successor over.
    // Its nanny is still writing the entry's log file, and the panel has to read it —
    // adopting a persistent entry must not cost its live output.
    const port = await freePort()
    // The successor runs the entry's *own* args: on Windows there is no per-process
    // environment to read, so the argv is the only thing that can prove it is ours.
    const code = `require("node:http").createServer((q,s)=>s.end("ok")).listen(${port},"127.0.0.1"); setInterval(() => {}, 1000)`
    const { supervisor, logDir } = await makeSupervisor([
      persistentConfig({ args: ['-e', code], port, onPortConflict: 'follow' }),
    ])

    const successor = spawn(process.execPath, ['-e', code], {
      env: { ...process.env, HHOSTED_SERVER_ID: 'keep' },
      stdio: 'ignore',
    })
    const successorPid = successor.pid!
    cleanups.push(() => {
      try {
        process.kill(successorPid, 'SIGKILL')
      }
      catch {
        // Already gone.
      }
    })
    while (!(await portAccepts(port)))
      await new Promise(resolve => setTimeout(resolve, 50))

    expect((await supervisor.start('keep')).ok).toBe(true)
    expect(view(supervisor, 'keep').adopted).toBe(true)

    // What a nanny would append next; the relay is the only thing that can surface it.
    const logFile = path.join(logDir, 'keep.log')
    fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(logFile, `${JSON.stringify({ ts: Date.now(), stream: 'stdout', text: 'adopted-live' })}\n`)

    await waitFor(() => supervisor.logLines('keep').some(line => line.text === 'adopted-live') ? true : undefined)
  })

  it('reports how a persistent entry ended while the panel was away', async () => {
    const { supervisor, nannyDir } = await makeSupervisor([persistentConfig()])
    // A heartbeat nobody refreshed: the nanny is gone, whatever the pid says.
    writeNannyState(nannyStatePath(nannyDir, 'keep'), {
      serverId: 'keep',
      nannyPid: 999_999,
      childPid: 999_998,
      startedAt: Date.now() - 60_000,
      logFile: '',
      heartbeatAt: Date.now() - 120_000,
      lastExit: { code: 3, signal: null, at: Date.now() - 30_000, runtimeMs: 30_000 },
    })

    await supervisor.startAll({ autostartOnly: true })

    expect(view(supervisor, 'keep').status).toBe('crashed')
    expect(supervisor.logLines('keep').some(line => line.text.includes('while the panel was away with code 3'))).toBe(true)
    // Read once: the state file is consumed, not replayed on the next boot.
    expect(readNannyState(nannyStatePath(nannyDir, 'keep'))).toBeNull()
  })

  it('ignores a state file whose recorded process is not there any more', async () => {
    const { supervisor, nannyDir } = await makeSupervisor([persistentConfig()])
    writeNannyState(nannyStatePath(nannyDir, 'keep'), {
      serverId: 'keep',
      nannyPid: 999_999,
      childPid: 999_998,
      startedAt: Date.now(),
      logFile: '',
      heartbeatAt: Date.now() - 120_000,
    })

    await supervisor.startAll({ autostartOnly: true })

    expect(view(supervisor, 'keep').status).toBe('stopped')
    expect(view(supervisor, 'keep').pid).toBeNull()
  })

  it('surfaces a persistent entry\'s crash output, not only its exit code', async () => {
    // A nanny writes the child's last lines and exits in the same breath, so the panel
    // can learn of the exit between two relay polls. Those lines are the whole reason a
    // person opens the panel; they must not depend on winning that race.
    armRealNannySpawn()
    const detail = 'boom: the entry refuses to start'
    const { supervisor } = await makeSupervisor([
      persistentConfig({
        args: ['-e', `console.error(${JSON.stringify(detail)}); process.exit(1)`],
        health: { enabled: false },
        restart: { maxRetries: 0, baseDelayMs: 50, factor: 2, maxDelayMs: 200, resetAfterMs: 60000 },
      }),
    ])

    await supervisor.start('keep')
    await waitFor(() => view(supervisor, 'keep').status === 'crashed')

    const texts = supervisor.logLines('keep').map(line => line.text)
    expect(texts.some(text => text.includes(detail))).toBe(true)
    // The panel's own start line reaches the same file the relay reads: an echo it
    // reads back is not a second start.
    expect(texts.filter(text => text.startsWith('start (persistent)'))).toHaveLength(1)
  })
})

/**
 * A compose entry is measured through docker, not by walking its wrapper's process tree.
 *
 * The containers are not descendants of `docker compose up` — they live in another namespace — so
 * the tree sample reported `cpuPercent: 0` for a stack burning a core, and an RSS a memory ceiling
 * could never trip. These drive a **real** `docker` on `PATH`: one `#!/bin/sh` shim that dispatches
 * on its first argument, answering `compose up` by staying alive (a real wrapper process to sample)
 * and `ps`/`stats` with the exact shapes docker prints. A shim, so skipped on Windows; the live
 * suite in `test/providers/docker.test.ts` drives a real daemon for what a shim cannot answer.
 */
describe('a docker-backed entry', () => {
  const posixShim = it.runIf(process.platform !== 'win32')

  /**
   * A project directory plus a `docker` first on `PATH`.
   *
   * `rss` is each container's used memory in docker's own units. The shim runs `up` as a real
   * process that stays up, so the entry has a wrapper to sample beside the containers.
   */
  async function withDockerShim(rss: string, body: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-sup-docker-'))
    // The project name is given on the argv, so the directory needs no legal basename.
    const project = path.join(dir, 'blog')
    await fs.promises.mkdir(project, { recursive: true })
    await fs.promises.writeFile(path.join(project, 'compose.yaml'), 'services: {}\n')

    const stats = [
      JSON.stringify({ CPUPerc: '91.50%', ID: 'aaaa11112222', MemUsage: `${rss} / 1GiB`, Name: 'blog-web-1', PIDs: '1' }),
      JSON.stringify({ CPUPerc: '1.00%', ID: 'bbbb33334444', MemUsage: '1MiB / 1GiB', Name: 'blog-db-1', PIDs: '2' }),
    ].join('\n')
    const ps = [
      `aaaa11112222\tblog-web-1\tblog\t${path.join(project, 'compose.yaml')}`,
      `bbbb33334444\tblog-db-1\tblog\t${path.join(project, 'compose.yaml')}`,
    ].join('\n')
    await fs.promises.writeFile(path.join(dir, 'ps.out'), ps)
    await fs.promises.writeFile(path.join(dir, 'stats.out'), stats)

    await fs.promises.writeFile(path.join(dir, 'docker'), `#!/bin/sh
case "$1" in
  ps) cat '${dir}/ps.out' ;;
  stats) cat '${dir}/stats.out' ;;
  compose) sleep 120 ;;
esac
exit 0
`, { mode: 0o755 })

    const original = process.env.PATH
    process.env.PATH = `${dir}${path.delimiter}${original ?? ''}`
    cleanups.push(async () => {
      process.env.PATH = original
      await fs.promises.rm(dir, { recursive: true, force: true })
    })
    await body(project)
  }

  /** A compose entry whose cwd holds the compose file, so detection finds it. */
  function composeConfig(project: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'blog',
      command: 'docker',
      args: ['compose', '-p', 'blog', 'up'],
      cwd: project,
      port: null,
      restart: { enabled: false },
      ...overrides,
    }
  }

  posixShim('reports the containers’ summed CPU and RSS, not the wrapper’s', async () => {
    await withDockerShim('64MiB', async (project) => {
      const { supervisor } = await makeSupervisor([composeConfig(project)])
      await supervisor.start('blog')
      await waitForStatus(supervisor, 'blog', 'running')

      // 91.5% + 1.0% CPU and 64MiB + 1MiB RSS come from docker; the wrapper is a sleeping shell.
      const sampled = await waitFor(() => {
        const live = view(supervisor, 'blog')
        return live.resources?.rssBytes === 65 * 1024 * 1024 ? live : undefined
      }, 25000)
      expect(sampled.resources!.cpuPercent, 'the busy container’s CPU, summed with the idle one').toBeCloseTo(92.5, 1)
      expect(sampled.resources!.processes).toBe(3)

      // The control: the wrapper's own tree is a shell, nowhere near the containers' sum. This is
      // the figure the entry reported before the change.
      const { ProcessSampler } = await import('#src/providers/proc')
      const tree = await new ProcessSampler().sample(view(supervisor, 'blog').pid!)
      expect(tree!.rssBytes, 'the wrapper is a different reading, which is why the tree sample was wrong').toBeLessThan(20 * 1024 * 1024)
    })
  }, 90000)

  /**
   * The point of the feature: a memory ceiling that fires on the containers.
   *
   * The wrapper is a shell sleeping for two minutes, so its tree is a few megabytes at most. The
   * ceiling is set above that and well below the containers' 65 MB — the measurement that separates
   * "fires on the stack" from "fires on the wrapper". Before this change this entry never restarted,
   * which is the silent guard the decision was about.
   */
  posixShim('fires resources.maxRssBytes on the summed container RSS', async () => {
    await withDockerShim('64MiB', async (project) => {
      const harness = await makeSupervisor([composeConfig(project, {
        // 8 MB: above this shell's own tree, far below the 65 MB the containers report.
        resources: { maxRssBytes: 8 * 1024 * 1024 },
      })])

      const sent: string[] = []
      const original = harness.notifications.notify.bind(harness.notifications)
      vi.spyOn(harness.notifications, 'notify').mockImplementation((event) => {
        sent.push(event.reason)
        original(event)
      })

      await harness.supervisor.start('blog')
      await waitForStatus(harness.supervisor, 'blog', 'running')

      // The restart the ceiling triggers resets the entry, so the notification and its log line are
      // the stable evidence that it fired. Asserted on the message text as well, because "rss"
      // alone would not show *which* number was over the limit.
      await waitFor(() => sent.includes('rss'), 40000)
      const logged = harness.supervisor.logLines('blog').map(line => line.text).join('\n')
      expect(logged, 'the message must name what was measured').toContain('containers use 65MB, over the 8MB limit')
    })
  }, 120000)

  /**
   * Until `docker stats` has answered, a compose entry's reading is its wrapper's own tree — and the
   * ceiling must not act on that: it names the containers. On a slow CI runner the wrapper alone
   * crossed an 8 MB limit first and was restarted as "containers use 9MB".
   */
  posixShim('does not hold a compose entry to its ceiling on the wrapper tree', async () => {
    await withDockerShim('64MiB', async (project) => {
      // No containers are listed, so no container reading can ever arrive.
      await fs.promises.writeFile(path.join(path.dirname(project), 'ps.out'), '')
      const harness = await makeSupervisor([composeConfig(project, { resources: { maxRssBytes: 1 } })])
      const sent: string[] = []
      vi.spyOn(harness.notifications, 'notify').mockImplementation((event) => {
        sent.push(event.reason)
      })

      await harness.supervisor.start('blog')
      await waitForStatus(harness.supervisor, 'blog', 'running')
      // Long enough for two resource samples of the wrapper, each far over a 1-byte limit.
      await waitFor(() => view(harness.supervisor, 'blog').resources?.rssBytes !== undefined ? true : undefined, 20000)
      await new Promise(resolve => setTimeout(resolve, 6000))
      expect(sent, 'the wrapper tree is not what the ceiling measures').not.toContain('rss')
    })
  }, 120000)

  /**
   * The other half of the rule: an entry that is not docker keeps the process-tree sample.
   *
   * A shell that happens to run docker is exactly the shape this cannot detect, and the honest
   * answer there is the tree it spawned — never the containers of a project it cannot be shown to
   * own.
   */
  posixShim('leaves a non-docker entry on the process-tree sample', async () => {
    await withDockerShim('64MiB', async () => {
      const { supervisor } = await makeSupervisor([{
        id: 'wrapped',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        port: null,
        restart: { enabled: false },
      }])
      await supervisor.start('wrapped')
      await waitForStatus(supervisor, 'wrapped', 'running')

      const sampled = await waitFor(() => {
        const live = view(supervisor, 'wrapped')
        return live.resources === null ? undefined : live
      }, 25000)
      // One node process, and the shim's 65 MiB / 91.5% never reach it.
      expect(sampled.resources!.processes, 'a non-docker entry is still measured by its own tree').toBe(1)
      expect(sampled.resources!.rssBytes).toBeLessThan(64 * 1024 * 1024)
      expect(sampled.resources!.cpuPercent ?? 0, 'the container shim’s 91.5% must not leak in').toBeLessThan(50)
    })
  }, 90000)
})

/**
 * A compose entry's server is its **containers**, and they outlive the wrapper this panel spawned.
 *
 * A reboot, a `docker compose up -d` from a shell, or a panel crash leaves them running with no
 * child of ours to signal — and this entry's stop path answered `{ ok: true }` for exactly that
 * state. Measured on the built panel: `POST /api/servers/web/stop` returned `{"ok":true}` while the
 * stack kept answering HTTP 200, `stop-all` did the same, and `down` exited 0 with it still up.
 *
 * These drive a **stateful** `docker` shim: `ps` reports `running`, `stop <name>` removes that name
 * from the file `ps` reads, so the assertion is about what a later listing says, not about a call
 * having been made. A shim, so skipped on Windows; the live suite in `test/providers/docker.test.ts`
 * drives a real daemon.
 */
describe('stopping a docker-backed entry that this panel did not spawn', () => {
  const posixShim = it.runIf(process.platform !== 'win32')

  /**
   * A project directory, a `docker` shim, and the running set it owns.
   *
   * `survivors` are the container names `docker stop` will refuse to remove, which is how the
   * "the stop did not take" half is staged: a shim that exits 0 without touching the file would
   * otherwise pass for a stop that worked.
   */
  async function withStack(body: (dir: string, running: () => string[], survivors: string[]) => Promise<void>, options: { survivors?: string[], gate?: boolean } = {}): Promise<void> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-sup-stack-'))
    const project = path.join(dir, 'blog')
    await fs.promises.mkdir(project, { recursive: true })
    await fs.promises.writeFile(path.join(project, 'compose.yaml'), 'services: {}\n')

    const names = ['blog-web-1', 'blog-db-1']
    await fs.promises.writeFile(path.join(dir, 'running'), `${names.join('\n')}\n`)
    await fs.promises.writeFile(path.join(dir, 'survivors'), `${(options.survivors ?? []).join('\n')}\n`)

    // `ps` prints the rows the real CLI prints for a compose project; `stop` rewrites the set unless
    // the name is in `survivors`. `stats` never answers, so the sampler keeps the tree reading —
    // these cases are about the stop, not about metrics.
    await fs.promises.writeFile(path.join(dir, 'docker'), `#!/bin/sh
case "$1" in
  ps)
    while read -r name; do
      [ -n "$name" ] && printf 'aaaa%s\\t%s\\tblog\\t%s\\n' "$name" "$name" '${project}/compose.yaml'
    done < '${dir}/running'
    ;;
  stop)
    ${options.gate === true
      ? `: > '${dir}/stopping'
    while [ ! -e '${dir}/release' ]; do sleep 0.05; done`
      : ''}
    # Every teardown is recorded, so a test can say how many ran rather than how many seemed to.
    echo stop >> '${dir}/stops'
    shift
    for name in "$@"; do
      if ! grep -qx "$name" '${dir}/survivors' 2>/dev/null; then
        grep -vx "$name" '${dir}/running' > '${dir}/running.tmp' || true
        mv '${dir}/running.tmp' '${dir}/running'
      fi
    done
    ;;
  compose) sleep 120 ;;
esac
exit 0
`, { mode: 0o755 })

    const original = process.env.PATH
    process.env.PATH = `${dir}${path.delimiter}${original ?? ''}`
    cleanups.push(async () => {
      process.env.PATH = original
      await fs.promises.rm(dir, { recursive: true, force: true })
    })
    await body(project, () => fs.readFileSync(path.join(dir, 'running'), 'utf8').split('\n').filter(Boolean), options.survivors ?? [])
  }

  /** A compose entry with the port the stack publishes, never started by this panel. */
  function stackConfig(project: string): Record<string, unknown> {
    return {
      id: 'blog',
      command: 'docker',
      args: ['compose', '-p', 'blog', 'up'],
      cwd: project,
      port: null,
      restart: { enabled: false },
    }
  }

  posixShim('stops the containers when nothing of ours is running', async () => {
    await withStack(async (project, running) => {
      const { supervisor } = await makeSupervisor([stackConfig(project)])
      // The state a reboot leaves: the stack is up, the panel has no child and no pid.
      expect(running(), 'the fixture must start with the stack up').toEqual(['blog-web-1', 'blog-db-1'])

      const result = await supervisor.stop('blog')
      expect(result, 'a stop that ended the whole stack is a success').toEqual({ ok: true })
      expect(running(), 'the containers are this entry’s server, so a stop must end them').toEqual([])
      expect(view(supervisor, 'blog').status).toBe('stopped')

      const logged = supervisor.logLines('blog').map(line => line.text).join('\n')
      expect(logged, 'the log must say which containers it stopped').toContain('stopped the containers blog-web-1, blog-db-1')
    })
  }, 60000)

  /**
   * The same refusal on the path that *did* spawn the wrapper.
   *
   * `docker compose up` normally takes its stack down on SIGTERM, so this is the case where it did
   * not: the wrapper is killed, the containers are still listed, and the old code dropped our
   * readings and answered "stopped" because the process it held was gone.
   */
  posixShim('refuses to claim "stopped" when the wrapper died but a container is still up', async () => {
    await withStack(async (project, running) => {
      const { supervisor } = await makeSupervisor([stackConfig(project)])
      await supervisor.start('blog')
      await waitForStatus(supervisor, 'blog', 'running')
      expect(view(supervisor, 'blog').pid, 'the fixture needs a wrapper of ours to stop').not.toBeNull()

      const result = await supervisor.stop('blog')
      expect(result.ok, 'a container that outlived the wrapper is still this entry’s server').toBe(false)
      expect(running()).toEqual(['blog-db-1'])
      const after = view(supervisor, 'blog')
      expect(after.status).toBe('conflict')
      expect(after.lastError).toContain('blog-db-1')
      expect(after.pid, 'the wrapper is gone, so its pid goes too, whatever the containers did').toBeNull()
    }, { survivors: ['blog-db-1'] })
  }, 60000)

  posixShim('refuses to claim "stopped" when a container is still up', async () => {
    // `docker stop` exits 0 for the container it cannot end. Trusting that answer is the empty
    // success this test exists to refuse: the page would say Stopped over a serving stack.
    await withStack(async (project, running) => {
      const { supervisor } = await makeSupervisor([stackConfig(project)])
      const result = await supervisor.stop('blog')

      expect(result.ok, 'the stack is still serving, so this is not a success').toBe(false)
      expect(result.error, 'the refusal must name the container that stayed up').toContain('blog-db-1')
      expect(running(), 'the surviving container is still running, which is the fact being reported').toEqual(['blog-db-1'])
      const after = view(supervisor, 'blog')
      expect(after.status, 'a stack that survived the stop is a conflict, never stopped').toBe('conflict')
      expect(after.lastError).toContain('still running')
    }, { survivors: ['blog-db-1'] })
  }, 60000)

  /**
   * The inverse interleaving: a start that lands while a stop is ending its stack.
   *
   * `stopEntry` clears `stopping` and `child` *before* awaiting `stopComposeStack`, so in that window
   * `start()` sees a stopped-looking entry and spawns for real. The stop's tail then ran on and
   * cleared the readings — which bumps the *new* run's `runToken`, drops its pid and publishes
   * `stopped` over a child that is still alive. Nothing is watching that child, so no exit event ever
   * arrives: exactly the orphan `runToken` exists to prevent, reached from the other direction.
   *
   * The window is held open by the shim's `stop`, which blocks until this test creates `release` —
   * so the start is *guaranteed* to land inside it rather than racing a sleep.
   */
  posixShim('a start accepted while the stop is ending its stack is not clobbered by that stop', async () => {
    await withStack(async (project, running) => {
      const dir = path.dirname(project)
      const { supervisor } = await makeSupervisor([{
        ...stackConfig(project),
        /**
         * Still `docker ... compose ...`, because `composeTarget` decides on the command *name* — an
         * entry whose command is `node` is not a compose entry at all, and would take the branch that
         * returns before the tail under test. The shim's `compose` case sleeps, so this is a wrapper
         * that stays up like a real `compose up`.
         */
        args: ['compose', '-p', 'blog', 'up'],
      }])
      await supervisor.start('blog')
      await waitForStatus(supervisor, 'blog', 'running')
      const firstPid = view(supervisor, 'blog').pid
      expect(firstPid, 'the fixture needs a wrapper of ours to stop').not.toBeNull()

      const stopping = supervisor.stop('blog')
      // Parked inside `stopComposeStack`, with `stopping` and `child` already cleared: the window.
      await waitFor(() => fs.existsSync(path.join(dir, 'stopping')))

      /**
       * The whole point: during the teardown the entry still reads as stopping, so `start()` refuses
       * rather than spawning a child this stop's tail would then forget. Before the reorder this
       * answered `ok: true` and spawned — the assertion that caught it.
       */
      const during = await supervisor.start('blog')
      expect(during.ok, 'a start during the teardown is refused, not spawned').toBe(false)
      expect(during.error, 'and it says why').toContain('stopping')

      await fs.promises.writeFile(path.join(dir, 'release'), '')
      await stopping

      const after = view(supervisor, 'blog')
      expect(after.status, 'the stop that finished publishes its own verdict').toBe('stopped')
      expect(after.pid, 'and nothing is left running that the panel has forgotten').toBeNull()
      expect(running(), 'the stack was stopped, which is what the stop was doing').toEqual([])

      // And the entry is startable again now that the stop is over.
      const later = await supervisor.start('blog')
      expect(later.ok, 'a start after the stop is accepted').toBe(true)
      expect(view(supervisor, 'blog').pid, 'and it has a pid of its own').not.toBe(firstPid)
    }, { gate: true })
  }, 60000)

  /**
   * The same clobbering, reached from the other side: two stops on one entry.
   *
   * `stopping` is a boolean owned by no stop, so two overlapping calls each cleared it at their own
   * tail. The first finisher dropped the flag while the second was still parked in
   * `stopComposeStack`, so `start()` saw a stopped-looking entry and spawned for real — and the
   * second tail then cleared the readings, dropped that pid and published `stopped` over a live
   * child. `stopEntry` now joins the in-flight stop, so there is only ever one tail.
   *
   * The window is held open by the `stop` shim, exactly as above, so the second stop is guaranteed
   * to arrive while the first is still tearing the stack down.
   */
  posixShim('a second stop joins the one in flight instead of racing its tail', async () => {
    await withStack(async (project, running) => {
      const dir = path.dirname(project)
      const { supervisor } = await makeSupervisor([{
        ...stackConfig(project),
        args: ['compose', '-p', 'blog', 'up'],
      }])
      await supervisor.start('blog')
      await waitForStatus(supervisor, 'blog', 'running')
      const firstPid = view(supervisor, 'blog').pid
      expect(firstPid, 'the fixture needs a wrapper of ours to stop').not.toBeNull()

      const stopping = supervisor.stop('blog')
      await waitFor(() => fs.existsSync(path.join(dir, 'stopping')))

      /**
       * Arrives inside the first stop's teardown. A joined stop is already waiting on that tail, so
       * it has no teardown of its own to start — which is what the `stops` count asserts after the
       * gate opens. A racing stop would enter `stopComposeStack` and block on the same gate.
       */
      const second = supervisor.stop('blog')

      await fs.promises.writeFile(path.join(dir, 'release'), '')
      const [first, joined] = await Promise.all([stopping, second])

      // Both callers get the same verdict from the one stop that ran.
      expect(first).toEqual(joined)
      expect(joined.ok, 'the stack was stopped, so the joined stop reports the stop that happened').toBe(true)
      expect(fs.readFileSync(path.join(dir, 'stops'), 'utf8').trim().split('\n').length, 'exactly one teardown ran in all').toBe(1)

      const after = view(supervisor, 'blog')
      expect(after.status, 'one tail published the verdict').toBe('stopped')
      expect(after.pid, 'and nothing is left running that the panel has forgotten').toBeNull()
      expect(running(), 'the stack was stopped once').toEqual([])

      // The real defect: the entry must be startable, and the start must not be forgotten.
      const later = await supervisor.start('blog')
      expect(later.ok, 'a start after the joined stop is accepted').toBe(true)
      const started = view(supervisor, 'blog')
      expect(started.pid, 'and it has a pid of its own').not.toBe(firstPid)
      expect(started.status, 'the start is not published as stopped').not.toBe('stopped')

      await supervisor.stop('blog')
    }, { gate: true })
  }, 60000)
})

/**
 * A stop, a disable, a removal or a dispose that lands while a start is still in flight — in its
 * bootstrap or its port preflight, both of which await — must win. The start used to read a
 * `stopping` flag the stop had already cleared, so the server spawned behind a "stopped" answer.
 */
describe('a stop during an in-flight start', () => {
  /** A worker that leaves its pid in `workerFile`, behind a bootstrap that leaves its pid in `bootFile`. */
  async function bootstrapped(bootMs = 3000): Promise<{ config: Record<string, unknown>, workerFile: string, bootFile: string }> {
    const dir = await scratchDir('hh-cancel-')
    const workerFile = path.join(dir, 'worker.pid')
    const bootFile = path.join(dir, 'boot.pid')
    cleanups.push(() => {
      for (const file of [workerFile, bootFile]) {
        try {
          process.kill(Number(fs.readFileSync(file, 'utf8')), 'SIGKILL')
        }
        catch {
          // Never written, or already gone.
        }
      }
    })
    const config = {
      id: 'w',
      command: process.execPath,
      args: ['-e', 'require("fs").writeFileSync(process.env.WP, String(process.pid)); setInterval(() => {}, 1000)'],
      env: { WP: workerFile },
      health: { enabled: false },
      restart: { enabled: false },
      bootstrap: {
        command: process.execPath,
        args: ['-e', `require("fs").writeFileSync(process.env.BP, String(process.pid)); setTimeout(() => {}, ${bootMs})`],
        env: { BP: bootFile },
        timeoutMs: 20000,
        runOnce: false,
      },
    }
    return { config, workerFile, bootFile }
  }

  async function settle(starting: Promise<{ ok: boolean }>): Promise<void> {
    expect((await starting).ok, 'the cancelled start must not report success').toBe(false)
    await new Promise(resolve => setTimeout(resolve, 400))
  }

  it('a stop during the bootstrap kills it and spawns nothing', async () => {
    const { config, workerFile, bootFile } = await bootstrapped()
    const { supervisor, history } = await makeSupervisor([config])

    const starting = supervisor.start('w', { actor: 'user' })
    await waitFor(() => fs.existsSync(bootFile))
    const bootPid = Number(fs.readFileSync(bootFile, 'utf8'))
    const began = Date.now()
    expect((await supervisor.stop('w')).ok).toBe(true)
    await settle(starting)

    expect(Date.now() - began, 'the stop does not wait out the bootstrap').toBeLessThan(2500)
    expect(isAlive(bootPid), 'the in-flight bootstrap is killed').toBe(false)
    expect(fs.existsSync(workerFile), 'no worker was spawned after the stop').toBe(false)
    expect(view(supervisor, 'w').status).toBe('stopped')
    expect(view(supervisor, 'w').pid).toBeNull()
    expect(history.all().filter(event => event.type === 'start')).toEqual([])
  })

  it('a stop while a dependency bootstraps neither waits for it nor spawns the dependent', async () => {
    const dependency = await bootstrapped()
    const dependent = await bootstrapped()
    const { supervisor } = await makeSupervisor([
      { ...dependency.config, id: 'db' },
      { ...dependent.config, id: 'app', bootstrap: null, dependsOn: ['db'] },
    ])

    const starting = supervisor.start('app', { actor: 'user' })
    await waitFor(() => fs.existsSync(dependency.bootFile))
    const began = Date.now()
    expect((await supervisor.stop('app')).ok).toBe(true)
    expect(Date.now() - began, 'the stop does not wait out the dependency’s bootstrap').toBeLessThan(1500)
    await settle(starting)

    expect(fs.existsSync(dependent.workerFile), 'the dependent was never spawned').toBe(false)
    await supervisor.stop('db')
  })

  it('a stop during the port preflight spawns nothing', async () => {
    const port = await freePort()
    const holder = net.createServer()
    await new Promise<void>(resolve => holder.listen(port, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>(resolve => holder.close(() => resolve())))
    const { config, workerFile } = await bootstrapped()
    const { supervisor } = await makeSupervisor([{ ...config, bootstrap: null, port, onPortConflict: 'warn' }])

    const starting = supervisor.start('w', { actor: 'user' })
    await waitFor(() => view(supervisor, 'w').status === 'starting')
    expect((await supervisor.stop('w')).ok).toBe(true)
    await settle(starting)

    expect(fs.existsSync(workerFile)).toBe(false)
    expect(view(supervisor, 'w').status).toBe('stopped')
  })

  it('a disable during the bootstrap spawns nothing', async () => {
    const { config, workerFile, bootFile } = await bootstrapped()
    const { supervisor, store } = await makeSupervisor([config])

    const starting = supervisor.start('w', { actor: 'user' })
    await waitFor(() => fs.existsSync(bootFile))
    store.updateServer('w', { enabled: false })
    await settle(starting)

    expect(fs.existsSync(workerFile)).toBe(false)
    expect(view(supervisor, 'w').pid).toBeNull()
  })

  it('a removal during the bootstrap leaves no child and no history', async () => {
    const { config, workerFile, bootFile } = await bootstrapped()
    const { supervisor, store, history } = await makeSupervisor([config])

    const starting = supervisor.start('w', { actor: 'user' })
    await waitFor(() => fs.existsSync(bootFile))
    store.removeServer('w')
    await settle(starting)

    expect(fs.existsSync(workerFile)).toBe(false)
    expect(history.all().filter(event => event.serverId === 'w')).toEqual([])
  })

  it('a dispose during the port preflight spawns nothing', async () => {
    const port = await freePort()
    const holder = net.createServer()
    await new Promise<void>(resolve => holder.listen(port, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>(resolve => holder.close(() => resolve())))
    const { config, workerFile } = await bootstrapped()
    const { supervisor } = await makeSupervisor([{ ...config, bootstrap: null, port, onPortConflict: 'warn' }])

    const starting = supervisor.start('w', { actor: 'user' })
    await waitFor(() => view(supervisor, 'w').status === 'starting')
    await supervisor.dispose()
    await settle(starting)

    expect(fs.existsSync(workerFile)).toBe(false)
  })
})

describe('a persistent entry whose nanny died while the panel was away', () => {
  it('is starting, then running, once a new nanny is attached', async () => {
    armRealNannySpawn()
    const { supervisor, nannyDir } = await makeSupervisor([{
      id: 'keep',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      persistent: true,
      autostart: false,
      health: { enabled: false },
    }])
    // A nanny pid that is certainly gone: a process that already exited.
    const dead = spawn(process.execPath, ['-e', ''])
    await new Promise(resolve => dead.once('exit', resolve))
    writeNannyState(nannyStatePath(nannyDir, 'keep'), {
      serverId: 'keep',
      nannyPid: dead.pid!,
      childPid: null,
      startedAt: Date.now() - 60000,
      logFile: '',
      heartbeatAt: Date.now() - 60000,
      lastExit: { code: 1, signal: null, at: Date.now() - 30000, runtimeMs: 30000 },
    } as NannyState)

    expect((await supervisor.start('keep', { actor: 'user' })).ok).toBe(true)
    await waitForStatus(supervisor, 'keep', 'running')
    expect(view(supervisor, 'keep').pid).not.toBeNull()
    expect((await supervisor.stop('keep')).ok).toBe(true)
  }, 20000)
})

/**
 * The panel signalled the nanny's whole group, which holds the child, and the nanny forwarded the
 * same signal again — so a server counting its SIGTERMs (a second one often means "now, hard") saw two.
 */
describe.skipIf(process.platform === 'win32')('a persistent entry’s stop signal', () => {
  it('reaches the child exactly once', async () => {
    armRealNannySpawn()
    const dir = await scratchDir('hh-sig-')
    const out = path.join(dir, 'signals.txt')
    const { supervisor } = await makeSupervisor([{
      id: 'keep',
      command: process.execPath,
      args: ['-e', 'process.on("SIGTERM", () => { require("fs").appendFileSync(process.env.OUT, "TERM\\n"); setTimeout(() => process.exit(0), 300) }); setInterval(() => {}, 1000)'],
      env: { OUT: out },
      persistent: true,
      autostart: false,
      health: { enabled: false },
      stop: { signal: 'SIGTERM', killGroup: true, graceMs: 3000 },
    }])

    expect((await supervisor.start('keep', { actor: 'user' })).ok).toBe(true)
    await waitForStatus(supervisor, 'keep', 'running')
    // The child has to be up and trapping before the stop, or the count says nothing.
    await waitFor(() => supervisor.logLines('keep').some(line => line.text.includes('runs this entry')))
    await new Promise(resolve => setTimeout(resolve, 500))
    expect((await supervisor.stop('keep')).ok).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(fs.readFileSync(out, 'utf8')).toBe('TERM\n')
  }, 20000)
})

/**
 * `persistent` takes effect at the next start. A save that turned it off under a running nanny made
 * the stop treat the nanny as a plain child: it signalled the whole group (the nanny forwarded the
 * signal again) and skipped the nanny's own teardown, leaving its state file — which the next
 * persistent start then read as "crashed while the panel was away".
 */
describe.skipIf(process.platform === 'win32')('turning persistent off while it runs', () => {
  it('stops the running nanny as a nanny, and leaves nothing to misreport later', async () => {
    armRealNannySpawn()
    const dir = await scratchDir('hh-flip-')
    const out = path.join(dir, 'signals.txt')
    const { supervisor, store, history, nannyDir } = await makeSupervisor([{
      id: 'keep',
      command: process.execPath,
      args: ['-e', 'process.on("SIGTERM", () => { require("fs").appendFileSync(process.env.OUT, "TERM\\n"); setTimeout(() => process.exit(0), 300) }); setInterval(() => {}, 1000)'],
      env: { OUT: out },
      persistent: true,
      autostart: false,
      health: { enabled: false },
      stop: { signal: 'SIGTERM', killGroup: true, graceMs: 3000 },
    }])

    expect((await supervisor.start('keep', { actor: 'user' })).ok).toBe(true)
    await waitForStatus(supervisor, 'keep', 'running')
    await waitFor(() => supervisor.logLines('keep').some(line => line.text.includes('runs this entry')))
    await new Promise(resolve => setTimeout(resolve, 500))

    store.updateServer('keep', { persistent: false })
    expect((await supervisor.stop('keep')).ok).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(fs.readFileSync(out, 'utf8'), 'the child got one SIGTERM, as a nanny\'s stop sends').toBe('TERM\n')
    expect(fs.existsSync(nannyStatePath(nannyDir, 'keep')), 'the nanny\'s teardown ran').toBe(false)
    expect(history.all().some(event => event.serverId === 'keep' && event.type === 'crash')).toBe(false)
  }, 20000)
})

describe('a health probe in flight across a stop', () => {
  it('does not report its verdict against the stopped entry', async () => {
    const port = await freePort()
    const { supervisor, history } = await makeSupervisor([{
      id: 'w',
      command: process.execPath,
      // Accepts and never answers, so an http probe hangs until its timeout.
      args: ['-e', 'require("net").createServer(() => {}).listen(Number(process.env.P), "127.0.0.1")'],
      env: { P: String(port) },
      port,
      restart: { enabled: false },
      health: { enabled: true, mode: 'http', intervalMs: 500, timeoutMs: 2500, unhealthyThreshold: 1, forceRestartAfterMs: 0, startTimeoutMs: 8000 },
    }])

    await supervisor.start('w', { actor: 'user' })
    await waitForStatus(supervisor, 'w', 'running')
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect((await supervisor.stop('w')).ok).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 3000))

    expect(view(supervisor, 'w').health).not.toBe('unhealthy')
    expect(view(supervisor, 'w').unhealthySince).toBeNull()
    expect(history.all().filter(event => event.type === 'unhealthy')).toEqual([])
  }, 20000)
})
