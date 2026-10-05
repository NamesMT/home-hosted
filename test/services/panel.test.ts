import type { AppState, WorkspaceView } from '#src/shared/contracts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

async function makeHarness(options: {
  workspaces?: Array<{ id: string, label: string }>
  servers?: Record<string, unknown>[]
  /** A real proxy service, so the frame carries one. */
  withProxy?: boolean
  autostart?: boolean
  defaultServersPath?: string
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
    ...(options.defaultServersPath === undefined ? {} : { defaultServersPath: options.defaultServersPath }),
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

  it('sees a hand edit through its own watchers, without a restart', async () => {
    const { panel, frames, dispose } = await makeHarness()

    try {
      const runtime = panel.requireWorkspace('default')
      fs.writeFileSync(runtime.store.path, JSON.stringify({
        $schema: './servers.config.schema.json',
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

      // Global settings are re-read too, so a restored listener takes effect.
      expect(settings.control.port).toBeGreaterThan(0)
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

  it('starts nothing on its own when autostart is off', async () => {
    const { panel, dispose } = await makeHarness({ autostart: false })

    try {
      const runtime = panel.requireWorkspace('default')
      fs.writeFileSync(runtime.store.path, JSON.stringify({
        $schema: './servers.config.schema.json',
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

  it('honours defaultServersPath for the default workspace only', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-panel-cfg-'))
    dirs.push(dir)
    const pinned = path.join(dir, 'pinned.json')
    fs.writeFileSync(pinned, JSON.stringify({ servers: [] }, null, 2))

    const { panel, dispose } = await makeHarness({
      workspaces: [{ id: 'default', label: 'Default' }, { id: 'staging', label: 'Staging' }],
      defaultServersPath: pinned,
    })

    try {
      // `--config` pins the default workspace's file; another workspace keeps its own.
      expect(panel.requireWorkspace('default').store.path).toBe(pinned)
      expect(panel.requireWorkspace('staging').store.path).not.toBe(pinned)
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
      expect(view.notifications.telegram.enabled).toBe(false)
      expect(view.logsDir).toContain('media')
    }
    finally {
      await dispose()
    }
  })
})
