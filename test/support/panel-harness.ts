/**
 * The real `PanelService` over a throwaway home, for the `test/services/panel*.test.ts` suites. Each
 * file registers `beforeEach(resetPanelModules)` and `afterEach(cleanPanelHarness)` itself.
 */
import type { AppState } from '#src/shared/contracts'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { vi } from 'vitest'
import { CONFIG_SCHEMA } from '#src/config/migrations'
import { testPort } from './ports'

const dirs: string[] = []
const originalHome = process.env.HHOSTED_HOME

/** Each case re-imports the graph, so the paths module reads that case's `HHOSTED_HOME`. */
export function resetPanelModules(): void {
  vi.resetModules()
}

/** Restores `HHOSTED_HOME` and removes every home a case made. */
export async function cleanPanelHarness(): Promise<void> {
  if (originalHome === undefined)
    delete process.env.HHOSTED_HOME
  else
    process.env.HHOSTED_HOME = originalHome
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
}

export interface Harness {
  /** The services the panel was built from, so a case can reach them by hand. */
  panel: import('#src/services/panel').PanelService
  registry: import('#src/config/workspaces').WorkspaceRegistry
  settings: import('#src/config/settings').GlobalSettingsStore
  secrets: import('#src/config/secrets').SecretsStore
  hub: import('#src/services/events').EventHub
  dir: string
  hhDir: string
  /** Every frame the panel published, newest last. */
  frames: AppState[]
  dispose: () => Promise<void>
}

/** Polls until the expectation holds, so a test never guesses at a sleep. */
export async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined && value !== false)
      return value
    if (Date.now() > deadline)
      throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** A port no parallel test can be handed too (see `test/support/ports.ts`). */
export async function freePortNumber(): Promise<number> {
  return testPort()
}

/** Whether anything accepts a connection there, which is what a port being held means. */
export async function portAcceptsOn(port: number): Promise<boolean> {
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

/**
 * Two real workspaces, one port: `default/owner` is up on it and `staging/borrower` wants it.
 *
 * The two entries deliberately differ in **id**, so the fixture never leans on the same-id
 * collision: it is the pid that crosses the boundary, which is the thing under test. Every other
 * line is what a person hand-writing the same service in two workspaces would produce.
 */
export async function twoWorkspacePortFixture(options: { policy: 'block' | 'follow' }): Promise<{
  panel: Harness['panel']
  owner: import('#src/services/supervisor').Supervisor
  borrower: import('#src/services/supervisor').Supervisor
  ownerPid: number
  port: number
  dispose: () => Promise<void>
}> {
  const port = await freePortNumber()
  const shared = {
    command: process.execPath,
    args: ['-e', 'require("node:http").createServer((q,s)=>s.end("ok")).listen(Number(process.env.PORT),"127.0.0.1")'],
    env: { PORT: '{port}' },
    port,
    health: { intervalMs: 500, timeoutMs: 500, unhealthyThreshold: 2, forceRestartAfterMs: 0, startTimeoutMs: 8000 },
    restart: { maxRetries: 3, baseDelayMs: 50, factor: 2, maxDelayMs: 200, resetAfterMs: 60000 },
  }
  const harness = await makeHarness({
    workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    servers: [{ ...shared, id: 'owner' }],
  })
  try {
    const staging = harness.panel.requireWorkspace('staging')
    fs.writeFileSync(staging.store.path, JSON.stringify({
      $schema: './servers.config.schema.json',
      meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
      servers: [{ ...shared, id: 'borrower', onPortConflict: options.policy }],
    }, null, 2))
    staging.store.reloadFromDisk()

    const owner = harness.panel.requireWorkspace('default').supervisor
    const borrower = staging.supervisor

    await owner.start('owner')
    await waitFor(() => owner.views().find(view => view.id === 'owner')?.status === 'running')
    const ownerPid = owner.views().find(view => view.id === 'owner')!.pid!
    if (!(ownerPid > 0))
      throw new Error('the owner never started, so there is no port holder to test with')

    return { ...harness, owner, borrower, ownerPid, port }
  }
  catch (error) {
    await harness.dispose()
    throw error
  }
}

export async function makeHarness(options: {
  workspaces?: Array<{ id: string, label: string }>
  servers?: Record<string, unknown>[]
  /** A real proxy service, so the frame carries one. */
  withProxy?: boolean
  autostart?: boolean
} = {}): Promise<Harness> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-panel-'))
  dirs.push(dir)
  process.env.HHOSTED_HOME = dir
  const hhDir = path.join(dir, '.hh')
  fs.mkdirSync(hhDir, { recursive: true })

  const declarations = options.workspaces ?? [{ id: 'default', label: 'Default' }]
  for (const workspace of declarations)
    fs.mkdirSync(path.join(hhDir, workspace.id), { recursive: true })

  const { WorkspaceRegistry } = await import('#src/config/workspaces')
  const registry = new WorkspaceRegistry()
  fs.writeFileSync(registry.path, JSON.stringify({
    $schema: './workspaces.schema.json',
    workspaces: declarations,
  }, null, 2))
  registry.load()

  const { GlobalSettingsStore } = await import('#src/config/settings')
  const settings = new GlobalSettingsStore()
  settings.load()

  const { SecretsStore } = await import('#src/config/secrets')
  const { AuthService } = await import('#src/services/auth')
  const secrets = new SecretsStore(path.join(hhDir, '.control-secrets.json'), undefined, 'global')
  const auth = new AuthService(secrets, () => settings.control.auth)

  const { TlsStore } = await import('#src/services/tls')
  const { EventHub } = await import('#src/services/events')
  const tls = new TlsStore(path.join(hhDir, '.tls'))
  const hub = new EventHub()

  const { BackupService } = await import('#src/services/backups')
  const { UiService } = await import('#src/services/ui')
  const { HostMonitor } = await import('#src/services/host-monitor')
  const { PanelService } = await import('#src/services/panel')

  // The panel and the backups service reference each other; one lazy holder breaks
  // the cycle without a use-before-define.
  let panelRef: import('#src/services/panel').PanelService | undefined
  const backups = new BackupService({
    dataRoot: hhDir,
    getConfig: () => settings.backups,
    getSources: () => panelRef!.backupSources(),
    onRestored: () => panelRef?.reloadAll(),
  })

  const stockDir = path.join(dir, 'stock')
  fs.mkdirSync(stockDir, { recursive: true })
  fs.writeFileSync(path.join(stockDir, 'index.html'), '<!doctype html><title>stock</title>')
  const ui = new UiService({ dataRoot: dir, stockDir })

  const hostMonitor = new HostMonitor(() => settings.host, (target: string) => target, [])

  const control = {
    host: 'local' as const,
    port: 3999,
    bindHost: '127.0.0.1',
    url: 'http://127.0.0.1:3999',
    protocol: 'http' as const,
  }

  let proxyService: import('#src/services/proxy').ProxyService | null = null
  if (options.withProxy === true) {
    const { ProxyService } = await import('#src/services/proxy')
    proxyService = new ProxyService({
      settings,
      binDir: path.join(hhDir, '.proxy', 'bin'),
      engineDir: path.join(hhDir, '.proxy', 'engine'),
      configPath: path.join(hhDir, '.proxy', 'engine', 'current.json'),
      previousConfigPath: path.join(hhDir, '.proxy', 'engine', 'previous.json'),
      stateDir: path.join(hhDir, '.proxy', 'state'),
      adminPath: path.join(hhDir, '.proxy', 'state', 'admin.json'),
      challengeAuthPath: path.join(hhDir, '.proxy', 'state', 'challenge.json'),
      logDir: path.join(hhDir, '.logs'),
      tlsDir: path.join(hhDir, '.proxy', 'tls'),
      control: () => control,
      resolveServer: () => null,
      exposureBlocked: () => null,
      onStateChange: () => panelRef?.notifyStateChange(),
    })
  }

  const panel = new PanelService({
    registry,
    settings,
    secrets,
    auth,
    tls,
    backups,
    ui,
    hostMonitor,
    hub,
    control: () => control,
    proxy: () => proxyService,
    autostart: options.autostart ?? false,
  })
  panelRef = panel

  // The frame the panel publishes is the only thing a UI ever sees, so observe it
  // the way a client would.
  const frames: AppState[] = []
  hub.subscribe(null, (message) => {
    if (message.type === 'state' && message.state !== undefined)
      frames.push(message.state)
  })

  // Seed each workspace's servers file *through the store the panel already built*,
  // which is how a hand edit arrives too.
  if (options.servers !== undefined) {
    fs.writeFileSync(panel.requireWorkspace('default').store.path, JSON.stringify({
      $schema: './servers.config.schema.json',
      meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
      servers: options.servers,
    }, null, 2))
    panel.requireWorkspace('default').store.reloadFromDisk()
  }

  return {
    panel,
    registry,
    settings,
    secrets,
    hub,
    dir,
    hhDir,
    frames,
    dispose: async () => {
      proxyService?.dispose()
      await panel.dispose()
    },
  }
}

export const runningServer: Record<string, unknown> = {
  id: 'sleepy',
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
}
