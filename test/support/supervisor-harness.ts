/**
 * The supervisor suites share one harness: a real `Supervisor` over a scratch workspace, plus the
 * waits and probes its tests poll with. Each file registers `afterEach(runCleanups)` itself.
 */
import type { ControlEndpoint } from '#src/services/control-server'
import type { ServerView } from '#src/shared/contracts'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CONFIG_SCHEMA } from '#src/config/migrations'
import { SecretsStore } from '#src/config/secrets'
import { GlobalSettingsStore } from '#src/config/settings'
import { WorkspaceStore } from '#src/config/store'
import { AuthService } from '#src/services/auth'
import { DdnsService } from '#src/services/ddns'
import { EventHub } from '#src/services/events'
import { HistoryStore } from '#src/services/history'
import { LogFiles } from '#src/services/log-files'
import { NotificationService } from '#src/services/notifications'
import { Supervisor } from '#src/services/supervisor'
import { TlsStore } from '#src/services/tls'
import { testPort } from './ports'

export const cleanups: Array<() => Promise<void> | void> = []

/** A scratch dir swept after the test — the `hh-load`/`hh-dump` homes had no cleanup at all. */
export async function scratchDir(prefix: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix))
  cleanups.push(() => fs.promises.rm(dir, { recursive: true, force: true }))
  return dir
}

/** Runs and drops every cleanup a test registered, newest first. */
export async function runCleanups(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
}

/** A port no parallel test can be handed too (see `test/support/ports.ts`). */
export async function freePort(): Promise<number> {
  return testPort()
}

// Generous: spawned children under a full parallel run on a slow machine can take seconds to speak.
export async function waitFor<T>(probe: () => T | undefined, timeoutMs = 30000): Promise<T> {
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

export interface SupervisorHarness {
  supervisor: Supervisor
  store: WorkspaceStore
  hub: EventHub
  settings: GlobalSettingsStore
  auth: AuthService
  control: ControlEndpoint
  tls: TlsStore
  notifications: NotificationService
  ddns: DdnsService
  /** The workspace's own state directory, so a second panel can boot over the same one. */
  dir: string
  nannyDir: string
  logDir: string
  logFiles: LogFiles
  history: HistoryStore
  /** How many times the supervisor has told the panel that something may have moved. */
  stateChanges: () => number
}

/**
 * A workspace's own state lives under one directory now: a `WorkspaceStore` for
 * its servers plus workspace settings, and a `GlobalSettingsStore` for the
 * panel-wide listener/auth policy. The supervisor itself only takes the pieces
 * it owns — it no longer builds the state frame (the panel does).
 *
 * `dir` reuses an existing state directory instead of a fresh one, which is how a second
 * panel is booted over the first one's state — the shape of a hard restart.
 */
export async function makeSupervisor(
  servers: Record<string, unknown>[],
  prepare?: (dir: string) => void | Promise<void>,
  existingDir?: string,
): Promise<SupervisorHarness> {
  const dir = existingDir ?? await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-sup-'))
  // State that must exist *before* the supervisor is constructed (a boot sweep, say).
  if (prepare !== undefined)
    await prepare(dir)
  const workspaceId = 'default'
  const file = path.join(dir, 'servers.config.json')
  await fs.promises.writeFile(file, JSON.stringify({ meta: { writtenBy: 'test', schema: CONFIG_SCHEMA }, servers }, null, 2))

  const store = new WorkspaceStore(workspaceId, path.join(dir, 'settings.json'), file)
  store.load()

  const settings = new GlobalSettingsStore(path.join(dir, 'global-settings.json'))
  settings.load()
  const secrets = new SecretsStore(path.join(dir, 'secrets.json'))
  const auth = new AuthService(secrets, () => settings.control.auth)
  const control: ControlEndpoint = { host: 'local', port: 3999, bindHost: '127.0.0.1', url: 'http://127.0.0.1:3999', protocol: 'http' }
  const tls = new TlsStore(path.join(dir, 'tls'))
  const logFiles = new LogFiles(path.join(dir, 'logs'), () => store.logs)
  const nannyDir = path.join(dir, 'state')
  const notifications = new NotificationService(secrets, () => store.notifications)
  const history = new HistoryStore(path.join(dir, 'history.json'))
  const ddns = new DdnsService({
    getConfig: () => store.ddns,
    getCredentials: (accountId, provider) => secrets.getDdnsCredentials(accountId, provider)?.values ?? null,
    notifications,
    statePath: path.join(dir, 'ddns.json'),
  })

  const hub = new EventHub()
  let stateChanges = 0
  const supervisor = new Supervisor(store, hub, {
    workspaceId,
    configPath: file,
    control,
    history,
    logFiles,
    notifications,
    onStateChange: () => {
      stateChanges += 1
    },
    nannyDir,
  })

  cleanups.push(async () => {
    await supervisor.dispose()
    logFiles.dispose()
    history.dispose()
    await fs.promises.rm(dir, { recursive: true, force: true })
  })

  return {
    supervisor,
    store,
    hub,
    settings,
    auth,
    control,
    tls,
    notifications,
    ddns,
    dir,
    nannyDir,
    logDir: logFiles.directory,
    logFiles,
    history,
    stateChanges: () => stateChanges,
  }
}

export function httpServerConfig(port: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/**
 * `spawnNanny()` re-runs this process's own entry point (`nannyEntryPoint()`), which
 * under vitest is the test worker. Pointing both at what `up` uses in production makes
 * the nanny a real one: this CLI, through tsx.
 */
export function armRealNannySpawn(): void {
  const argv1 = process.argv[1] ?? ''
  const execArgv = process.execArgv
  process.argv[1] = fileURLToPath(new URL('../../src/cli.ts', import.meta.url))
  process.execArgv = ['--import=tsx']
  cleanups.push(() => {
    process.argv[1] = argv1
    process.execArgv = execArgv
  })
}

export function view(supervisor: Supervisor, id: string): ServerView {
  const found = supervisor.views().find(entry => entry.id === id)
  if (!found)
    throw new Error(`no view for ${id}`)
  return found
}

export async function waitForStatus(supervisor: Supervisor, id: string, status: ServerView['status']): Promise<void> {
  try {
    await waitFor(() => view(supervisor, id).status === status)
  }
  catch (error) {
    const logs = supervisor.logLines(id).map(line => `[${line.stream}] ${line.text}`).join('\n')
    throw new Error(`${error instanceof Error ? error.message : error}\nview: ${JSON.stringify(view(supervisor, id))}\nlogs:\n${logs}`)
  }
}

export async function portAccepts(port: number): Promise<boolean> {
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

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}
