import type { NotificationEvent } from '#src/services/notifications'
import type { AppState, WorkspaceView } from '#src/shared/contracts'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_SCHEMA } from '#src/config/migrations'
import { isPortFree } from '#src/providers/port'

/**
 * The real `PanelService`, not a stand-in.
 *
 * Every route suite runs against `test/api/fixture.ts`, which re-implements this
 * class's surface over its own stores — deliberately, because the routes are what
 * those tests are about. That leaves the wiring here uncovered: which service each
 * workspace gets, that a create really lands in the registry, that a hand edit
 * reaches the supervisor, that a broken config is reported without stopping
 * anything, and that dispose tears down what the constructor started.
 *
 * `PanelService` builds every path from the module constants in
 * `#src/helpers/paths.ts`, so each case sets `HHOSTED_HOME` to its own temp
 * directory and re-imports the graph — never the developer's real home. The same
 * trick `test/config/layout.test.ts` uses.
 */

const dirs: string[] = []
const originalHome = process.env.HHOSTED_HOME

beforeEach(() => {
  vi.resetModules()
})

afterEach(async () => {
  if (originalHome === undefined)
    delete process.env.HHOSTED_HOME
  else
    process.env.HHOSTED_HOME = originalHome
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

interface Harness {
  /** The services the panel was built from, so a case can reach them by hand. */
  panel: import('#src/services/panel').PanelService
  registry: import('#src/config/workspaces').WorkspaceRegistry
  settings: import('#src/config/settings').GlobalSettingsStore
  hub: import('#src/services/events').EventHub
  dir: string
  hhDir: string
  /** Every frame the panel published, newest last. */
  frames: AppState[]
  dispose: () => Promise<void>
}

/** Polls until the expectation holds, so a test never guesses at a sleep. */
async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 10000): Promise<T> {
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

/**
 * A port nothing is listening on. Binding `0` asks the OS, then the listener closes, so the number is
 * free by the time a case uses it; the poll absorbs the few milliseconds a just-closed socket can
 * still answer in.
 */
async function freePortNumber(): Promise<number> {
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

/** Whether anything accepts a connection there, which is what a port being held means. */
async function portAcceptsOn(port: number): Promise<boolean> {
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
async function twoWorkspacePortFixture(options: { policy: 'block' | 'follow' }): Promise<{
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

async function makeHarness(options: {
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

const runningServer: Record<string, unknown> = {
  id: 'sleepy',
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
}

describe('panelService', () => {
  it('builds one isolated runtime per registered workspace', async () => {
    const { panel, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      expect(panel.workspaces().map(runtime => runtime.id)).toEqual(['default', 'staging'])

      // A workspace is the ownership boundary: same-named things inside two
      // workspaces must not share a file, a store or a supervisor.
      const [first, second] = panel.workspaces()
      expect(first!.store.path).not.toBe(second!.store.path)
      expect(first!.secrets.path).not.toBe(second!.secrets.path)
      expect(first!.logsDir).not.toBe(second!.logsDir)
      expect(second!.logsDir.startsWith(second!.store.path)).toBe(false)
      expect(first!.supervisor).not.toBe(second!.supervisor)
      // A notification cooldown is keyed by `serverId:reason`, with no workspace in the key — which
      // is only safe because each workspace owns its own service. Prove it behaviourally: one
      // workspace's flapping `api` must not silence the other's, which is exactly what a shared
      // service would do. Telegram is switched on for both, or `shouldNotify` answers false for
      // every event and the assertion below would hold vacuously.
      expect(first!.notifications).not.toBe(second!.notifications)
      for (const runtime of [first!, second!])
        runtime.store.updateNotifications({ destinations: [{ kind: 'telegram', id: 'tg', enabled: true, chatId: '1', cooldownMs: 60_000 }] })
      const flap: NotificationEvent = { serverId: 'api', label: 'api', reason: 'crash', detail: 'boom' }
      const now = 1_000_000
      first!.notifications.markSent(flap, now)
      expect(first!.notifications.shouldNotify(flap, now + 1), 'the same workspace is cooled down').toBe(false)
      expect(second!.notifications.shouldNotify(flap, now + 1), 'another workspace must not be').toBe(true)

      // Each keeps its own label and view.
      expect(panel.workspace('staging')?.label).toBe('Staging')
      expect(panel.workspace('ghost')).toBeUndefined()
    }
    finally {
      await dispose()
    }
  })

  it('resolves the default workspace lazily, and refuses an unknown id', async () => {
    const { panel, registry, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      expect(panel.defaultId()).toBe('default')
      expect(panel.requireWorkspace().id).toBe('default')
      expect(panel.requireWorkspace('staging').id).toBe('staging')
      // An empty id means the default, never another workspace.
      expect(panel.requireWorkspace('').id).toBe('default')
      expect(() => panel.requireWorkspace('nope')).toThrow(/unknown workspace/)

      // When the registry's default is gone, the first remaining runtime answers —
      // rather than an id nothing can resolve.
      registry.remove('default')
      expect(panel.defaultId()).toBe('staging')
    }
    finally {
      await dispose()
    }
  })

  it('creates and renames a workspace through the registry, not beside it', async () => {
    const { panel, registry, dispose } = await makeHarness()

    try {
      const created = panel.create({ id: 'media', label: 'Media' })
      expect(created.id).toBe('media')
      expect(panel.workspace('media')).toBeDefined()
      // The registry is the durable record; the runtime follows it.
      expect(registry.all().map(entry => entry.id)).toContain('media')
      expect(fs.readFileSync(registry.path, 'utf8')).toContain('"media"')

      // Its directory and seeded config exist, so a restart finds the same shape.
      const runtime = panel.workspace('media')!
      expect(fs.existsSync(runtime.store.path)).toBe(true)
      expect(runtime.store.servers).toEqual([])

      const renamed = panel.rename('media', 'Media Server')
      expect(renamed.label).toBe('Media Server')
      expect(panel.workspace('media')?.label).toBe('Media Server')
      expect(registry.get('media')?.label).toBe('Media Server')

      expect(() => panel.rename('ghost', 'x')).toThrow(/unknown workspace/)
    }
    finally {
      await dispose()
    }
  })

  it('removes a workspace with its directory, and never the last one', async () => {
    const { panel, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      const dir = path.dirname(panel.requireWorkspace('staging').store.path)
      expect(fs.existsSync(dir)).toBe(true)

      await panel.remove('staging')
      expect(panel.workspace('staging')).toBeUndefined()
      expect(panel.workspaces().map(runtime => runtime.id)).toEqual(['default'])
      // The directory goes with it: a re-created id must not inherit its state.
      expect(fs.existsSync(dir)).toBe(false)

      // One workspace is the floor — the panel would have nowhere to put anything.
      await expect(panel.remove('default')).rejects.toThrow(/only workspace/)
    }
    finally {
      await dispose()
    }
  })

  /**
   * A workspace is not removed while one of its processes survived the stop.
   *
   * `stopEntry` keeps a persistent entry's nanny state **on purpose** when its pid outlived SIGKILL —
   * "its pid is in the state file" is how a later boot reaches a child the stop could not forward. That
   * file sits under `workspaceDir(id)`, which removal deletes recursively, so removing anyway leaves the
   * process running with nothing that knows its name. The loop used to log the failure and continue.
   */
  it('refuses to remove a workspace whose process survived the stop', async () => {
    const { panel, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      const runtime = panel.requireWorkspace('staging')
      const dir = path.dirname(runtime.store.path)
      expect(fs.existsSync(dir)).toBe(true)

      // `makeHarness` seeds `servers` into the *default* workspace, so the removal loop would find
      // nothing to stop here. Write this workspace's own file, then reload the store it already built.
      const stuck = { id: 'stuck', command: process.execPath, args: ['-e', 'null'] }
      fs.writeFileSync(runtime.store.path, JSON.stringify({ $schema: './servers.config.schema.json', meta: { writtenBy: 'test', schema: CONFIG_SCHEMA }, servers: [stuck] }, null, 2))
      runtime.store.reloadFromDisk()
      expect(runtime.store.servers, 'the workspace must have a server to stop').toHaveLength(1)

      // Exactly what `stopEntry` returns for a pid that outlived SIGKILL.
      vi.spyOn(runtime.supervisor, 'stop').mockResolvedValue({ ok: false, error: 'pid 4242 survived the stop' })

      await expect(panel.remove('staging')).rejects.toThrow(/survived the stop/)
      // Nothing was removed: the workspace is still registered and its directory is intact, which is
      // what keeps the surviving process findable.
      expect(panel.workspace('staging')).toBeDefined()
      expect(fs.existsSync(dir), 'the state file that finds the process must survive').toBe(true)
    }
    finally {
      await dispose()
    }
  })

  it('resolves a server by its (workspace, server) pair, never by id alone', async () => {
    const { panel, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
      servers: [{ id: 'shared', command: process.execPath, args: ['-e', 'null'] }],
    })

    try {
      const found = panel.findServer('default', 'shared')
      expect(found?.config.id).toBe('shared')
      expect(found?.workspace.id).toBe('default')

      // The same id in a workspace that has no such entry is a miss, not a borrow.
      expect(panel.findServer('staging', 'shared')).toBeNull()
      expect(panel.findServer('ghost', 'shared')).toBeNull()
      expect(panel.findServer('default', 'ghost')).toBeNull()
    }
    finally {
      await dispose()
    }
  })

  /**
   * A port held by another workspace's server is this panel's server, not a stranger to free.
   *
   * `Supervisor.supervisedPids()` only walks its own entries, so a sibling workspace's pid looked
   * foreign to every consumer of the split. Measured on a real panel with two workspaces, a
   * `free-port` on `staging` terminated `default`'s server on the shared port and answered
   * `{"ok":true,"terminated":[<default's pid>],"free":true}` while that workspace's entry restarted
   * under a new pid; `follow` then adopted the sibling's process, so both workspaces reported the
   * same pid as running and stopping one left the other claiming it. One guard, because both halves
   * are the same split — the two assertions are kept apart so a fix to one cannot hide the other.
   */
  it('never frees a port held by another workspace', async () => {
    const { owner, borrower, ownerPid, port, dispose } = await twoWorkspacePortFixture({ policy: 'block' })

    try {
      const freed = await borrower.freePort('borrower')
      expect(freed.ok, 'freeing a sibling workspace\'s port is a refusal, not a success').toBe(false)
      expect(freed.terminated).toEqual([])
      expect(freed.error).toContain('which this panel supervises')
      // And it says *where* to go: the holder is on a page this workspace's UI cannot show.
      expect(freed.error).toContain('default/owner')

      // The owner is untouched: still the same process, still serving.
      const ownerView = owner.views().find(view => view.id === 'owner')!
      expect(ownerView.status).toBe('running')
      expect(ownerView.pid).toBe(ownerPid)
      expect(await portAcceptsOn(port), 'the sibling must still be serving its port').toBe(true)
    }
    finally {
      await dispose()
    }
  })

  it('never adopts another workspace\'s process, even under `follow`', async () => {
    const { owner, borrower, ownerPid, dispose } = await twoWorkspacePortFixture({ policy: 'follow' })

    try {
      const started = await borrower.start('borrower')
      expect(started.ok, 'a sibling workspace\'s process must not be adopted as this entry').toBe(false)
      // And no second claim on the pid: the borrower stays down while the owner keeps it.
      expect(borrower.views().find(view => view.id === 'borrower')!.pid).toBeNull()
      expect(owner.views().find(view => view.id === 'owner')!.pid).toBe(ownerPid)
    }
    finally {
      await dispose()
    }
  })

  it('lists every workspace DDNS account, with the credentials that belong to it', async () => {
    const { panel, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      const defaults = panel.requireWorkspace('default')
      const staging = panel.requireWorkspace('staging')

      // One account that can answer a challenge (Cloudflare) and one that cannot
      // (No-IP): the proxy page reads this to decide what it may offer, so both
      // flags matter.
      defaults.store.updateDdns({ accounts: [{ id: 'cf', provider: 'cloudflare', label: 'Cloudflare' }] })
      staging.store.updateDdns({ accounts: [{ id: 'noip', provider: 'noip', label: 'No-IP' }] })

      const accounts = panel.listDnsAccounts()
      expect(accounts).toEqual([
        { workspace: 'default', account: 'cf', provider: 'cloudflare', label: 'Cloudflare', writesTxt: true, hasCredentials: false },
        { workspace: 'staging', account: 'noip', provider: 'noip', label: 'No-IP', writesTxt: false, hasCredentials: false },
      ])

      // Credentials live with the workspace that owns the account, and the flag
      // follows them.
      defaults.secrets.setDdnsCredentials('cf', 'cloudflare', { apiToken: 'secret-token' })
      expect(panel.listDnsAccounts()[0]!.hasCredentials).toBe(true)
      expect(panel.findDnsAccount('default', 'cf')?.credentials).toEqual({ apiToken: 'secret-token' })
      // The pair is the key: the same account id in another workspace is not it.
      expect(panel.findDnsAccount('staging', 'cf')).toBeNull()
      expect(panel.findDnsAccount('ghost', 'cf')).toBeNull()
      expect(panel.findDnsAccount('default', 'ghost')).toBeNull()
    }
    finally {
      await dispose()
    }
  })

  it('scopes server views to one workspace, or flattens them all', async () => {
    const { panel, dispose } = await makeHarness()

    try {
      expect(panel.serverViews()).toEqual([])
      expect(panel.serverViews('default')).toEqual([])
      // An unknown workspace is empty, not everything.
      expect(panel.serverViews('ghost')).toEqual([])
    }
    finally {
      await dispose()
    }
  })

  it('frames the whole panel in one state object', async () => {
    const { panel, hhDir, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      const state = panel.getState()
      expect(state.control.port).toBe(3999)
      expect(state.workspaces.map(workspace => workspace.id)).toEqual(['default', 'staging'])
      expect(state.dataRoot).toBe(path.join(hhDir, '..').replace(/\/$/, ''))
      expect(state.projectDir.length).toBeGreaterThan(0)
      expect(typeof state.version).toBe('string')

      // A panel with no proxy says nothing about one: the field is additive, and an
      // older UI must not be handed a half-built proxy view.
      expect(state.proxy).toBeUndefined()
    }
    finally {
      await dispose()
    }
  })

  it('carries the proxy in the frame when the panel has one', async () => {
    const { panel, dispose } = await makeHarness({ withProxy: true })

    try {
      const state = panel.getState()
      expect(state.proxy).toBeDefined()
      expect(state.proxy?.status.state).toBe('off')
      // Not installed, so the engine says so rather than pretending.
      expect(state.proxy?.engine.installed).toBe(false)
      expect(state.proxy?.routes).toEqual([])
    }
    finally {
      await dispose()
    }
  })

  it('reports the sources a backup is built from', async () => {
    const { panel, hhDir, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
      servers: [{ id: 'web', command: process.execPath, args: ['-e', 'null'] }],
    })

    try {
      const sources = panel.backupSources()
      expect(sources.globalSecretsPath).toContain('.control-secrets.json')
      expect(sources.globalSettingsPath).toContain('settings.json')
      expect(sources.tlsDir).toContain('.tls')
      expect(sources.includePaths).toEqual(panel.settings.backups.includePaths)

      // One source per workspace, each naming its own files — and the servers it
      // declares, so the restore plan can list them.
      expect(sources.workspaces.map(workspace => workspace.id)).toEqual(['default', 'staging'])
      const first = sources.workspaces[0]!
      expect(first.serversPath).toBe(panel.requireWorkspace('default').store.path)
      expect(first.settingsPath).toBe(panel.requireWorkspace('default').store.settingsPath)
      expect(first.secretsPath).toBe(panel.requireWorkspace('default').secrets.path)
      expect(first.servers.map(server => server.id)).toEqual(['web'])
      expect(sources.workspaces[1]!.servers).toEqual([])

      // The global leaves really exist under $HHOSTED_HOME/.hh.
      expect(fs.existsSync(sources.globalSecretsPath)).toBe(false)
      expect(path.dirname(sources.globalSettingsPath)).toBe(hhDir)
    }
    finally {
      await dispose()
    }
  })

  it('publishes one frame per turn, and only when something actually changed', async () => {
    const { panel, frames, dispose } = await makeHarness()

    try {
      panel.notifyStateChange()
      await waitFor(() => frames.length > 0)
      const first = frames.length

      // Two signals in the same turn coalesce into at most one more frame.
      panel.notifyStateChange()
      panel.notifyStateChange()
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(frames.length).toBeLessThanOrEqual(first + 1)

      // A repeat of the same state is not news: the signature gate drops it.
      const settled = frames.length
      panel.notifyStateChange()
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(frames.length).toBe(settled)
    }
    finally {
      await dispose()
    }
  })

  /**
   * Switching host sampling off publishes a frame.
   *
   * `host.enabled` is not a decoration on the wire: four surfaces in both UIs render it as their
   * whole empty state (`HostVitals`' head says "sampling off", `HostVitalsPanel` swaps the dial
   * grid for one, `HostRail` and `InstrumentCluster` each fall back to it). `stateSignature` named
   * only `sampledAt` and `alerts` for the host block, and the disabled branch of `HostMonitor.tick`
   * writes neither — it keeps the last sample and flips `enabled`. So the transition published
   * **nothing at all**, and a second tab kept drawing live dials for a panel that had stopped
   * measuring: the same stale-view defect this function has already been fixed twice for
   * (`ui` above, a destination's policy below), each time by adding the one field that was missing.
   *
   * Driving the real monitor rather than patching its view: the disabled branch is where the field
   * is written, so a hand-set `enabled` would only prove the signature covers a field, not that the
   * transition reaches a client.
   */
  /**
   * Switching host sampling off publishes a frame.
   *
   * `host.enabled` is not decoration on the wire: four surfaces in both UIs render it as their whole
   * empty state — `HostVitals`' head reads "sampling off", `HostVitalsPanel` swaps its dial grid for
   * one, and `HostRail`/`InstrumentCluster` each fall back to it. `stateSignature` named only
   * `sampledAt` and `alerts` for the host block, and the disabled branch of `HostMonitor.tick` writes
   * neither: it keeps the last sample and flips `enabled`. Measured on the real service — sample,
   * publish, disable, tick, `notifyStateChange()` — the frame count stayed at 2 and both frames still
   * read `enabled: true`, so a second tab kept drawing live dials for a panel that had stopped
   * measuring. It is the same stale-view defect this function has been fixed for twice before (`ui`
   * below, a destination's policy after it), and each time the fix was one more hand-picked field.
   *
   * The sample's own frame is published *before* the switch, deliberately: a test that skipped that
   * pass would leave the sample "banked" in the signature and the switch would publish a frame for
   * the wrong reason — which is exactly how the first version of this test went green.
   */
  it('carries a switch of host sampling into a published frame', async () => {
    const { panel, settings, frames, dispose } = await makeHarness()
    const hostMonitor = (panel as unknown as {
      options: { hostMonitor: { tick: (now?: number) => Promise<void> } }
    }).options.hostMonitor
    const realTick = hostMonitor.tick.bind(hostMonitor)
    /*
     * The panel's own timer ticks `HostMonitor` on the *real* clock every second, so a simulated
     * tick 20 s ahead would be followed a second later by a real one that samples again, and the
     * fixture rather than the code would be what moved `sampledAt`. Only the ticks below get through.
     */
    let allowed = false
    hostMonitor.tick = async (now?: number) => {
      if (allowed)
        await realTick(now)
    }

    try {
      // A real sample, then its frame — so what is left to report is the switch alone. Past the
      // 15 s default interval, or the tick skips and there is no sample to go stale.
      allowed = true
      await realTick(20_000)
      allowed = false
      panel.notifyStateChange()
      await waitFor(() => frames.some(frame => frame.host.sampledAt !== null))
      const sampled = frames.at(-1)!
      const sampledAt = sampled.host.sampledAt
      expect(sampled.host.enabled, 'the sample itself should report sampling on').toBe(true)

      settings.updateHost({ enabled: false })
      allowed = true
      await realTick(20_000)
      allowed = false
      expect(panel.getState().host.enabled, 'the monitor did not record the switch').toBe(false)

      // The routes publish through this door. The client has to be told.
      const before = frames.length
      panel.notifyStateChange()
      await waitFor(() => frames.length > before)

      const last = frames.at(-1)!
      expect(last.host.enabled, 'a switched-off sampler was published as sampling').toBe(false)
      // The last reading stays on the frame with its timestamp, so a surface can say how old it is
      // rather than imply it is current.
      expect(last.host.sampledAt).toBe(sampledAt)
    }
    finally {
      await dispose()
    }
  })

  /**
   * `ui` is part of the state frame — Global Settings → Interface reads which UI is installed
   * straight from it — but it was missing from `stateSignature`, the gate that decides whether
   * a frame is published at all. A UI upload or revert therefore published nothing on its own;
   * it surfaced only when something *else* moved, which the host sample eventually does.
   *
   * Asserting on the published frames rather than their count: the host sample is in the
   * signature too, so a count can move for reasons that have nothing to do with `ui`.
   */
  it('carries the served UI change into a published frame', async () => {
    const { panel, frames, dispose } = await makeHarness()

    try {
      const patched = panel as unknown as { options: { ui: { status: () => unknown } } }
      let custom = false
      patched.options.ui.status = () => (custom
        ? { custom: true, dir: '/tmp/custom-ui', meta: { name: 'mine', version: '1.0.0' } }
        : { custom: false, dir: '/tmp/stock-ui', meta: null })

      panel.notifyStateChange()
      await waitFor(() => frames.length > 0)
      expect(frames.at(-1)?.ui).toMatchObject({ custom: false })

      // Freeze what the signature already tracks, so the only thing that can make this frame
      // new is `ui` itself.
      const host = (patched as unknown as { options: { hostMonitor: { current: unknown, tick: () => Promise<void> } } }).options.hostMonitor
      const fixed = { ...(host.current as object) }
      host.tick = async () => { host.current = fixed }

      const before = frames.length
      custom = true
      panel.notifyStateChange()
      await new Promise(resolve => setTimeout(resolve, 200))

      expect(frames.length, 'a UI change published no frame').toBeGreaterThan(before)
      expect(frames.at(-1)?.ui).toMatchObject({ custom: true, meta: { name: 'mine' } })
    }
    finally {
      await dispose()
    }
  })

  /**
   * A save that only changes a destination's policy must publish a frame.
   *
   * The signature keyed on `id:kind:enabled:tokenSet:lastResult` only, so changing
   * `useOwnSettings`, a chat id, a URL or any toggle published nothing — the page kept showing the
   * old values until the host sample happened to move, up to one interval later.
   */
  it('publishes a frame when only a destination policy value changes', async () => {
    const { panel, frames, dispose } = await makeHarness()

    try {
      const runtime = panel.requireWorkspace('default')
      runtime.store.updateNotifications({ destinations: [{ kind: 'webhook', id: 'hook', url: 'https://ntfy.sh/a', useOwnSettings: true }] })

      // Freeze the clock-driven parts, so the policy edit is the only thing that can move.
      const patched = panel as unknown as { options: { hostMonitor: { current: unknown, tick: () => Promise<void> } } }
      const host = patched.options.hostMonitor
      const fixed = { ...(host.current as object) }
      host.tick = async () => { host.current = fixed }

      panel.notifyStateChange()
      await waitFor(() => frames.length > 0)
      const before = frames.length

      runtime.store.updateNotifications({ destinations: [{ kind: 'webhook', id: 'hook', url: 'https://ntfy.sh/a', useOwnSettings: true, onCrash: false }] })
      panel.notifyStateChange()
      await new Promise(resolve => setTimeout(resolve, 200))

      expect(frames.length, 'a policy-only edit published no frame').toBeGreaterThan(before)
      expect(frames.at(-1)?.workspaces[0]?.notifications.destinations?.[0]).toMatchObject({ id: 'hook', onCrash: false })
    }
    finally {
      await dispose()
    }
  })

  it('sees a hand edit through its own watchers, without a restart', async () => {
    const { panel, frames, dispose } = await makeHarness()

    try {
      const runtime = panel.requireWorkspace('default')
      fs.writeFileSync(runtime.store.path, JSON.stringify({
        $schema: './servers.config.schema.json',
        meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
        servers: [{ id: 'added', command: process.execPath, args: ['-e', 'null'] }],
      }, null, 2))

      // The panel's own ConfigWatch is what has to notice, so this waits on the real
      // watch rather than calling the private handler.
      await waitFor(() => runtime.store.servers.some(server => server.id === 'added'))
      await waitFor(() => frames.some(frame => frame.workspaces.some(workspace => workspace.serverCount === 1)))
    }
    finally {
      await dispose()
    }
  })

  it('keeps running what it has when a hand edit is unreadable', async () => {
    const { panel, dispose } = await makeHarness({
      servers: [{ id: 'web', command: process.execPath, args: ['-e', 'null'] }],
    })

    try {
      const runtime = panel.requireWorkspace('default')
      expect(runtime.store.servers.map(server => server.id)).toEqual(['web'])

      fs.writeFileSync(runtime.store.path, '{ this is not json')

      // A typo must never stop a server: the error is reported and the live config
      // is kept, which is the whole point of the tolerant reader.
      await waitFor(() => runtime.store.configError !== null)
      expect(runtime.store.servers.map(server => server.id)).toEqual(['web'])
      expect(panel.getState().workspaces[0]!.configError).not.toBeNull()

      // …and fixing it clears the error without a restart.
      fs.writeFileSync(runtime.store.path, JSON.stringify({
        $schema: './servers.config.schema.json',
        meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
        servers: [{ id: 'web', command: process.execPath, args: ['-e', 'null'] }],
      }, null, 2))
      await waitFor(() => runtime.store.configError === null)
    }
    finally {
      await dispose()
    }
  })

  it('reloads every workspace, e.g. after a restore', async () => {
    const { panel, settings, dispose } = await makeHarness({
      servers: [{ id: 'web', command: process.execPath, args: ['-e', 'null'] }],
    })

    try {
      const runtime = panel.requireWorkspace('default')
      // A write that bypasses the panel's own save path, then a load.
      const raw = JSON.parse(fs.readFileSync(runtime.store.path, 'utf8')) as { servers: unknown[] }
      raw.servers = [{ id: 'restored', command: process.execPath, args: ['-e', 'null'] }]
      fs.writeFileSync(runtime.store.path, JSON.stringify(raw, null, 2))

      panel.reloadAll()
      expect(runtime.store.servers.map(server => server.id)).toEqual(['restored'])

      // Global settings are re-read too, so a restored listener takes effect. Asserted against a
      // value written to disk *after* the store was first loaded: the previous
      // `expect(settings.control.port).toBeGreaterThan(0)` held either way, since the port defaults
      // to a valid number and nothing here wrote global settings at all — deleting
      // `settings.load()` from `reloadAll()` left it green.
      const onDisk = JSON.parse(fs.readFileSync(settings.path, 'utf8')) as { control?: { label?: string } }
      onDisk.control = { ...onDisk.control, label: 'restored-panel' }
      fs.writeFileSync(settings.path, JSON.stringify(onDisk, null, 2))

      panel.reloadAll()
      expect(settings.control.label, 'reloadAll must re-read the global settings file').toBe('restored-panel')
    }
    finally {
      await dispose()
    }
  })

  it('starts an added autostart entry only when autostart is on', async () => {
    const { panel, dispose } = await makeHarness({ autostart: true })

    try {
      const runtime = panel.requireWorkspace('default')
      const before = panel.serverViews().length
      expect(before).toBe(0)

      fs.writeFileSync(runtime.store.path, JSON.stringify({
        $schema: './servers.config.schema.json',
        meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
        servers: [{ ...runningServer, id: 'auto', autostart: true, enabled: true }],
      }, null, 2))

      // The panel's own path from a hand edit to a started process.
      const started = await waitFor(() => {
        const view = panel.serverViews()[0]
        return view !== undefined && view.status !== 'stopped' ? view : undefined
      }, 20000)
      expect(started.id).toBe('auto')
      expect(started.config.autostart).toBe(true)
    }
    finally {
      await dispose()
    }
  })

  /**
   * A restore ends with `reloadAll()`, and `store.load()` resets the byte baseline the
   * config watcher compares against. The poll that follows therefore reports "no change",
   * so the autostart pass in `handleConfigChange` never ran and a restored entry stayed
   * stopped until the panel was restarted — against the README's "autostart entries come
   * up immediately".
   */
  it('starts an autostart entry that a restore revealed, without waiting for a restart', async () => {
    const { panel, dispose } = await makeHarness({ autostart: true })

    try {
      const runtime = panel.requireWorkspace('default')
      expect(runtime.store.servers).toHaveLength(0)

      // What a restore does: write the archive's servers file, then re-read everything.
      fs.writeFileSync(runtime.store.path, JSON.stringify({
        $schema: './servers.config.schema.json',
        meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
        servers: [{ ...runningServer, id: 'restored', autostart: true, enabled: true }],
      }, null, 2))
      panel.reloadAll()

      const started = await waitFor(() => {
        const view = panel.serverViews()[0]
        return view !== undefined && view.status !== 'stopped' ? view : undefined
      }, 20000)
      expect(started.id).toBe('restored')
    }
    finally {
      await dispose()
    }
  })

  /**
   * A workspace the archive created is built by `ensureWorkspace`, whose `createRuntime`
   * loads the restored servers file — so the `reloadAll()` that follows sees no *new* ids
   * and would leave its autostart entries stopped.
   */
  it('starts the autostart entries of a workspace a restore created', async () => {
    const { panel, hhDir, dispose } = await makeHarness({ autostart: true })

    try {
      // What the restore writes before it registers the workspace.
      const staging = path.join(hhDir, 'staging')
      fs.mkdirSync(staging, { recursive: true })
      fs.writeFileSync(path.join(staging, 'servers.config.json'), JSON.stringify({
        meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
        servers: [{ ...runningServer, id: 'restored', autostart: true, enabled: true }],
      }, null, 2))

      panel.ensureWorkspace({ id: 'staging', label: 'Staging' })

      const started = await waitFor(() => {
        const view = panel.requireWorkspace('staging').supervisor.views()[0]
        return view !== undefined && view.status !== 'stopped' ? view : undefined
      }, 20000)
      expect(started.id).toBe('restored')
    }
    finally {
      await dispose()
    }
  })

  it('starts nothing on its own when autostart is off', async () => {
    const { panel, dispose } = await makeHarness({ autostart: false })

    try {
      const runtime = panel.requireWorkspace('default')
      fs.writeFileSync(runtime.store.path, JSON.stringify({
        $schema: './servers.config.schema.json',
        meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
        servers: [{ ...runningServer, id: 'auto', autostart: true, enabled: true }],
      }, null, 2))

      await waitFor(() => runtime.store.servers.some(server => server.id === 'auto'))
      // `--no-autostart` still means the panel starts nothing by itself.
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(panel.serverViews().every(view => view.status === 'stopped')).toBe(true)
    }
    finally {
      await dispose()
    }
  })

  it('gives every workspace its own servers file under the state root', async () => {
    const { panel, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      // One file per workspace, always at its own path: `up` takes no override, so the file the
      // panel supervises is the file a hand edit, a restore and an offline backup all read.
      const { workspaceServersPath } = await import('#src/helpers/paths')
      for (const id of ['default', 'staging'])
        expect(panel.requireWorkspace(id).store.path).toBe(workspaceServersPath(id))
      expect(panel.requireWorkspace('default').store.path).not.toBe(panel.requireWorkspace('staging').store.path)
    }
    finally {
      await dispose()
    }
  })

  it('tears down what it started, and stops publishing', async () => {
    const { panel, frames, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
    })

    try {
      // A frame is published while the panel is live.
      panel.notifyStateChange()
      await waitFor(() => frames.length > 0)
      const settled = frames.length

      await panel.dispose()

      // A disposed panel never frames again, even if a late signal arrives: the
      // watchers and timers it owns are gone, and the interval is cleared.
      panel.notifyStateChange()
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(frames.length).toBe(settled)
    }
    finally {
      // The harness dispose is what releases the proxy and the temp directory.
      await dispose()
    }
  })

  it('drives host sampling from its own tick, without throwing out of the interval', async () => {
    const { panel, settings, dispose } = await makeHarness({ withProxy: true })

    try {
      // The tick is the only thing that samples host vitals, and a throw inside it
      // would be an unhandled rejection — which ends the process on Node 24.
      expect(panel.getState().host.sampledAt).toBeNull()

      settings.updateHost({ enabled: true, intervalMs: 5000 })
      const sampled = await waitFor(() => panel.getState().host.sampledAt ?? undefined, 20000)
      expect(typeof sampled).toBe('number')

      // …and the panel kept building whole frames throughout.
      const state = panel.getState()
      expect(state.workspaces).toHaveLength(1)
      expect(state.proxy).toBeDefined()
    }
    finally {
      await dispose()
    }
  })
})

describe('the state frame a UI actually reads', () => {
  it('keeps a workspace view whole across a create', async () => {
    const { panel, frames, dispose } = await makeHarness()

    try {
      panel.create({ id: 'media', label: 'Media' })
      const frame = await waitFor(() => frames.find(entry => entry.workspaces.some(workspace => workspace.id === 'media')))
      const view = frame.workspaces.find(workspace => workspace.id === 'media') as WorkspaceView

      expect(view.label).toBe('Media')
      expect(view.serverCount).toBe(0)
      expect(view.runningCount).toBe(0)
      expect(view.configError).toBeNull()
      // The new workspace carries the general block and no destinations until one is added.
      expect(view.notifications.defaults?.onCrash).toBe(true)
      expect(view.notifications.destinations).toEqual([])
      expect(view.logsDir).toContain('media')
    }
    finally {
      await dispose()
    }
  })
})
