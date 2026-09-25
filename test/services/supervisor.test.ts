import type { ControlEndpoint } from '#src/services/control-server'
import type { ServerView, SseMessage } from '#src/shared/contracts'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretsStore } from '#src/config/secrets'
import { ConfigStore } from '#src/config/store'
import { projectDir } from '#src/helpers/paths'
import { isPortFree } from '#src/providers/port'
import { AuthService } from '#src/services/auth'
import { BackupService } from '#src/services/backups'
import { EventHub } from '#src/services/events'
import { HistoryStore } from '#src/services/history'
import { HostMonitor } from '#src/services/host-monitor'
import { LogFiles } from '#src/services/log-files'
import { NotificationService } from '#src/services/notifications'
import { buildAppState } from '#src/services/state'
import { Supervisor } from '#src/services/supervisor'
import { TlsStore } from '#src/services/tls'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * Binds port 0 to let the OS pick, then polls until the port is genuinely free:
 * a just-closed listener can still complete a handshake for a few milliseconds.
 */
async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const bound = typeof address === 'object' && address !== null ? address.port : 0
        server.close(() => resolve(bound))
      })
    })

    for (let probe = 0; probe < 20; probe++) {
      if (await isPortFree(port))
        return port
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  throw new Error('could not allocate a free port')
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined && value !== false)
      return value
    if (Date.now() > deadline)
      throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function makeSupervisor(servers: Record<string, unknown>[]): Promise<{ supervisor: Supervisor, store: ConfigStore, hub: EventHub }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-sup-'))
  const file = path.join(dir, 'servers.config.json')
  await fs.promises.writeFile(file, JSON.stringify({ control: { port: 3999 }, servers }, null, 2))

  const store = new ConfigStore(file)
  store.load()
  const secrets = new SecretsStore(path.join(dir, 'secrets.json'))
  const auth = new AuthService(secrets, () => store.config.control.auth)
  const control: ControlEndpoint = { host: 'local', port: 3999, bindHost: '127.0.0.1', url: 'http://127.0.0.1:3999', protocol: 'http' }
  const tls = new TlsStore(path.join(dir, 'tls'))
  const logFiles = new LogFiles(path.join(dir, 'logs'), () => store.config.logs)
  const notifications = new NotificationService(secrets, () => store.config.notifications, () => store.config.logs)
  const history = new HistoryStore(path.join(dir, 'history.json'))
  const hostMonitor = new HostMonitor(() => store.config.host, target => path.resolve(dir, target), notifications)
  const backups = new BackupService({
    dataRoot: dir,
    getConfig: () => store.config.backups,
    getSources: () => ({
      configPath: file,
      secretsPath: path.join(dir, 'secrets.json'),
      tlsDir: path.join(dir, 'tls'),
      paths: [],
    }),
  })

  const hub = new EventHub()
  const supervisor = new Supervisor(store, hub, {
    configPath: file,
    control,
    buildState: views => buildAppState({
      store,
      auth,
      control,
      tls,
      notifications,
      hostMonitor,
      backups,
      logsDir: logFiles.directory,
      views,
    }),
    history,
    logFiles,
    notifications,
    hostMonitor,
  })

  cleanups.push(async () => {
    await supervisor.dispose()
    logFiles.dispose()
    history.dispose()
    await fs.promises.rm(dir, { recursive: true, force: true })
  })

  return { supervisor, store, hub }
}

function httpServerConfig(port: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'web',
    command: process.execPath,
    args: ['-e', 'require("node:http").createServer((q,s)=>s.end("ok")).listen(Number(process.env.PORT),"127.0.0.1")'],
    env: { PORT: '{port}' },
    port,
    health: { intervalMs: 500, timeoutMs: 500, unhealthyThreshold: 2, forceRestartAfterMs: 0, startTimeoutMs: 8000 },
    restart: { maxRetries: 3, baseDelayMs: 50, factor: 2, maxDelayMs: 200, resetAfterMs: 60000 },
    ...overrides,
  }
}

function view(supervisor: Supervisor, id: string): ServerView {
  const found = supervisor.views().find(entry => entry.id === id)
  if (!found)
    throw new Error(`no view for ${id}`)
  return found
}

async function waitForStatus(supervisor: Supervisor, id: string, status: ServerView['status']): Promise<void> {
  try {
    await waitFor(() => view(supervisor, id).status === status)
  }
  catch (error) {
    const logs = supervisor.logLines(id).map(line => `[${line.stream}] ${line.text}`).join('\n')
    throw new Error(`${error instanceof Error ? error.message : error}\nview: ${JSON.stringify(view(supervisor, id))}\nlogs:\n${logs}`)
  }
}

async function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.setTimeout(500)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

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

  it('exposes config and state through getState', async () => {
    const port = await freePort()
    const { supervisor, store } = await makeSupervisor([httpServerConfig(port)])

    const state = supervisor.getState()
    expect(state.control.port).toBe(3999)
    expect(state.configPath).toBe(store.path)
    expect(state.projectDir).toBe(projectDir)
    expect(state.servers).toHaveLength(1)
    expect(state.servers[0]?.status).toBe('stopped')
    expect(state.configError).toBeNull()
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

  it('follows a detached restart that lost the environment marker, by its argv', async () => {
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
    const { supervisor, hub } = await makeSupervisor([{
      id: 'idle',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      health: { enabled: false },
    }])

    const sampledAt: number[] = []
    cleanups.push(hub.subscribe(null, (message: SseMessage) => {
      if (message.type === 'state')
        sampledAt.push(message.state?.servers[0]?.resources?.sampledAt ?? 0)
    }))

    await supervisor.start('idle')
    await waitForStatus(supervisor, 'idle', 'running')

    // Resources are sampled every 5 s; two distinct samples prove the frames flow.
    const deadline = Date.now() + 14000
    while (new Set(sampledAt.filter(value => value > 0)).size < 2 && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 200))

    const distinct = new Set(sampledAt.filter(value => value > 0))
    expect(distinct.size).toBeGreaterThanOrEqual(2)
    // Nothing structural moved to earn those frames.
    expect(view(supervisor, 'idle').status).toBe('running')
    expect(view(supervisor, 'idle').health).toBe('disabled')
  })
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}
