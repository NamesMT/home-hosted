import type { AppDeps } from '#src/app'
import type { DdnsFetch } from '#src/providers/ddns/types'
import type { ControlEndpoint } from '#src/services/control-server'
import type { PanelService, WorkspaceRuntime } from '#src/services/panel'
import type { AppState, Bind, FreePortResult, LogLine, ServerConfig, ServerView } from '#src/shared/contracts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { createRootApp } from '#src/app'
import { SecretsStore } from '#src/config/secrets'
import { GlobalSettingsStore } from '#src/config/settings'
import { WorkspaceStore } from '#src/config/store'
import { WorkspaceError, WorkspaceRegistry } from '#src/config/workspaces'
import { AuthService } from '#src/services/auth'
import { BackupService } from '#src/services/backups'
import { DdnsService } from '#src/services/ddns'
import { EventHub } from '#src/services/events'
import { checkProxyExposure } from '#src/services/exposure'
import { HistoryStore } from '#src/services/history'
import { HostMonitor } from '#src/services/host-monitor'
import { LogFiles } from '#src/services/log-files'
import { NotificationService as Notifications } from '#src/services/notifications'
import { ProxyService } from '#src/services/proxy'
import { buildControlView, buildWorkspaceView } from '#src/services/state'
import { TlsStore } from '#src/services/tls'
import { UiService } from '#src/services/ui'

/**
 * The whole panel, wired the way `src/services/panel.ts` wires it, over real stores in
 * an explicit temp directory — plus a stand-in supervisor, because these tests are about
 * what the routes answer, not about supervising anything.
 *
 * A real `PanelService` cannot be used here: it builds every path from the module
 * constants in `#src/helpers/paths.ts`, so every fixture in a file would share one `.hh`
 * (and the developer's own). This keeps the same *shape* — one runtime per workspace,
 * panel-wide services on `panel` — over stores whose file paths the fixture chooses.
 *
 * The wrapper around the root app fakes the peer address: srvx sets `req.raw.ip` on a
 * real connection, and the loopback rules (`/_hh/shutdown`, first-time password setup)
 * are exactly what needs exercising.
 */

export interface FakeSupervisor {
  views: () => ServerView[]
  getState: () => AppState
  startAll: (options?: { autostartOnly?: boolean }) => Promise<void>
  stopAll: () => Promise<void>
  start: (id: string) => Promise<{ ok: boolean, error?: string }>
  stop: (id: string) => Promise<{ ok: boolean, error?: string }>
  restart: (id: string) => Promise<{ ok: boolean, error?: string }>
  clearLogs: (id: string) => void
  logLines: (id: string, limit?: number) => LogLine[]
  freePort: (id: string) => Promise<FreePortResult>
  dispose: () => Promise<void>
}

/** One workspace's runtime, plus the pieces a test reaches for by hand. */
export interface FixtureWorkspace {
  id: string
  label: string
  runtime: WorkspaceRuntime
  store: WorkspaceStore
  secrets: SecretsStore
  logFiles: LogFiles
  notifications: Notifications
  ddns: DdnsService
  supervisor: FakeSupervisor
}

export interface Fixture {
  app: Hono
  dir: string
  /** The panel-wide settings: listener, auth, TLS policy, host vitals, backups. */
  settings: GlobalSettingsStore
  registry: WorkspaceRegistry
  panel: PanelService
  /** The `?workspace=` id the routes resolve when none is given. */
  defaultId: string
  /** Every workspace's runtime, keyed by id. */
  workspaces: Map<string, FixtureWorkspace>
  /** The default workspace's own state; `store.path` is its servers file. */
  store: WorkspaceStore
  secrets: SecretsStore
  auth: AuthService
  logFiles: LogFiles
  backups: BackupService
  tls: TlsStore
  ui: UiService
  hub: EventHub
  notifications: Notifications
  ddns: DdnsService
  supervisor: FakeSupervisor
  controlServer: { endpoint: ControlEndpoint, rebind: (next: { host: Bind, port: number }) => Promise<{ ok: boolean, error?: string }>, restart: () => Promise<{ ok: boolean, error?: string }> }
  shutdownCalls: () => number
  serverViews: ServerView[]
  cleanup: () => Promise<void>
}

/** A view carrying every field the panel routes actually read. */
export function makeView(id: string, overrides: Partial<ServerView> = {}): ServerView {
  return {
    id,
    status: 'stopped',
    health: 'disabled',
    restarts: 0,
    responseMs: null,
    resources: null,
    history: { crashes: 0, uptimeRatio: null },
    config: { id, autostart: false, enabled: true, label: id } as ServerConfig,
    ...overrides,
  } as unknown as ServerView
}

export interface FixtureOptions {
  /** Raw entries handed to the default workspace's servers file before it is loaded. */
  servers?: Record<string, unknown>[]
  /** Extra workspaces, each with its own servers file. `default` is always the first. */
  workspaces?: Array<{ id: string, label?: string, servers?: Record<string, unknown>[] }>
  views?: ServerView[]
  /** Views for one named workspace; the default workspace still uses `views`. */
  workspaceViews?: Record<string, ServerView[]>
  /** Set a real password, which arms the auth guard. */
  password?: string
  /** Peer address the routes observe. */
  ip?: string | null
  /** Replaces the DDNS service's outbound fetch, so a pass can be exercised offline. */
  ddnsFetch?: DdnsFetch
}

function emptySupervisor(views: ServerView[]): FakeSupervisor {
  return {
    views: () => views,
    getState: () => ({}) as never,
    startAll: async () => {},
    stopAll: async () => {},
    start: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    restart: async () => ({ ok: true }),
    clearLogs: () => {},
    logLines: () => [],
    freePort: async () => ({ ok: true, port: null, terminated: [], forced: [], skipped: [], free: true }),
    dispose: async () => {},
  }
}

export async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-api-'))
  const hhDir = path.join(dir, '.hh')
  const workspaceDir = (id: string) => path.join(hhDir, id)
  const workspaceSettingsFile = (id: string) => path.join(workspaceDir(id), 'settings.json')
  const workspaceServersFile = (id: string) => path.join(workspaceDir(id), 'servers.config.json')
  const workspaceSecretsFile = (id: string) => path.join(workspaceDir(id), '.secrets.json')
  fs.mkdirSync(hhDir, { recursive: true })

  const declarations = [
    { id: 'default', label: 'Default', servers: options.servers ?? [] },
    ...(options.workspaces ?? []).map(entry => ({ label: entry.label ?? entry.id, servers: [], ...entry })),
  ]
  for (const workspace of declarations)
    fs.mkdirSync(workspaceDir(workspace.id), { recursive: true })

  const registry = new WorkspaceRegistry(path.join(hhDir, 'workspaces.json'))
  fs.writeFileSync(registry.path, JSON.stringify({
    $schema: './workspaces.schema.json',
    workspaces: declarations.map(workspace => ({ id: workspace.id, label: workspace.label })),
  }, null, 2))
  registry.load()

  const settings = new GlobalSettingsStore(path.join(hhDir, 'settings.json'))
  settings.load()

  const globalSecrets = new SecretsStore(path.join(hhDir, '.control-secrets.json'), undefined, 'global')
  const auth = new AuthService(globalSecrets, () => settings.control.auth)
  if (options.password !== undefined)
    auth.setPassword(options.password)

  const tls = new TlsStore(path.join(hhDir, '.tls'))
  const hub = new EventHub()

  const makeWorkspace = (declaration: { id: string, label: string, servers: Record<string, unknown>[] }): FixtureWorkspace => {
    // A workspace created through the route lands here without its directory yet.
    fs.mkdirSync(workspaceDir(declaration.id), { recursive: true })
    const serversFile = workspaceServersFile(declaration.id)
    fs.writeFileSync(serversFile, JSON.stringify({
      $schema: './servers.config.schema.json',
      servers: declaration.servers,
    }, null, 2))

    const store = new WorkspaceStore(declaration.id, workspaceSettingsFile(declaration.id), serversFile)
    store.load()

    const secrets = new SecretsStore(workspaceSecretsFile(declaration.id), undefined, 'workspace')
    const logFiles = new LogFiles(path.join(workspaceDir(declaration.id), '.logs'), () => store.logs)
    const notifications = new Notifications(secrets, () => store.notifications, () => store.logs)
    const ddns = new DdnsService({
      getConfig: () => store.ddns,
      getCredentials: (accountId, provider) => secrets.getDdnsCredentials(accountId, provider)?.values ?? null,
      notifications,
      statePath: path.join(workspaceDir(declaration.id), '.state', 'ddns.json'),
      ...(options.ddnsFetch === undefined ? {} : { fetchImpl: options.ddnsFetch }),
    })

    const views = options.workspaceViews?.[declaration.id] ?? (declaration.id === 'default' ? options.views ?? [] : [])
    // A real `ServerView` carries the workspace that owns it; only id is unique now.
    const tagged = views.map(view => (view.workspaceId === undefined ? { ...view, workspaceId: declaration.id } : view))
    const supervisor = emptySupervisor(tagged)

    const runtime: WorkspaceRuntime = {
      id: declaration.id,
      label: declaration.label,
      store,
      secrets,
      logFiles,
      history: new HistoryStore(path.join(workspaceDir(declaration.id), '.logs', 'history.json')),
      notifications,
      ddns,
      supervisor: supervisor as unknown as WorkspaceRuntime['supervisor'],
      watches: [],
      logsDir: logFiles.directory,
      reportedConfigError: store.configError,
      view: () => buildWorkspaceView({
        id: declaration.id,
        label: runtime.label,
        store,
        logsDir: logFiles.directory,
        notifications,
        ddns,
        supervisor,
      }),
    }

    return { id: declaration.id, label: declaration.label, runtime, store, secrets, logFiles, notifications, ddns, supervisor }
  }

  const workspaces = new Map<string, FixtureWorkspace>(declarations.map((declaration) => {
    const created = makeWorkspace(declaration)
    return [created.id, created]
  }))
  const defaultWorkspace = workspaces.get('default')!
  /** The default workspace's views, tagged with the workspace that owns them. */
  const defaultViews = defaultWorkspace.supervisor.views()

  const hostMonitor = new HostMonitor(
    () => settings.host,
    (target: string) => target,
    [...workspaces.values()].map(workspace => workspace.notifications),
  )

  // The panel and the backups service reference each other, so one lazy holder
  // breaks the cycle without a use-before-define.
  let panelApi: { backupSources: () => unknown } | undefined

  const backups = new BackupService({
    dataRoot: dir,
    getConfig: () => settings.backups,
    // The real `BackupSources` panel-wide shape; see `PanelService.backupSources()`.
    getSources: () => panelApi!.backupSources() as never,
  })

  const stockDir = path.join(dir, 'stock')
  fs.mkdirSync(stockDir, { recursive: true })
  fs.writeFileSync(path.join(stockDir, 'index.html'), '<!doctype html><title>stock</title>')
  const ui = new UiService({ dataRoot: dir, stockDir })

  const endpoint: ControlEndpoint = {
    host: 'local',
    port: 3999,
    bindHost: '127.0.0.1',
    url: 'http://127.0.0.1:3999',
    protocol: 'http',
  }

  /**
   * Exactly the surface the routes use, backed by the real registry so
   * `/api/workspaces` CRUD is really exercised. Cast because the class carries
   * internals (the tick, the state signature) the fixture has no use for.
   */
  const panel = {
    settings,
    workspaces: () => [...workspaces.values()].map(workspace => workspace.runtime),
    workspace: (id: string) => workspaces.get(id)?.runtime,
    defaultId: () => registry.defaultId,
    requireWorkspace(id?: string): WorkspaceRuntime {
      const resolved = id === undefined || id.length === 0 ? registry.defaultId : id
      const runtime = workspaces.get(resolved)?.runtime
      if (runtime === undefined)
        throw new WorkspaceError(`unknown workspace "${id ?? resolved}"`)
      return runtime
    },
    serverViews: (workspaceId?: string) => workspaceId === undefined
      ? [...workspaces.values()].flatMap(workspace => workspace.supervisor.views())
      : workspaces.get(workspaceId)?.supervisor.views() ?? [],
    getState: (): AppState => ({
      control: buildControlView(settings, auth, endpoint, tls),
      host: hostMonitor.view,
      backups: backups.view(),
      ui: ui.status(),
      workspaces: [...workspaces.values()].map(workspace => workspace.runtime.view()),
      projectDir: dir,
      dataRoot: dir,
    }),
    create: (input: { id?: string, label?: string }) => {
      const workspace = registry.create(input)
      const created = makeWorkspace({ id: workspace.id, label: workspace.label, servers: [] })
      workspaces.set(workspace.id, created)
      return created.runtime.view()
    },
    rename: (id: string, label: string) => {
      const workspace = registry.rename(id, label)
      const existing = workspaces.get(id)
      if (existing === undefined)
        throw new WorkspaceError(`unknown workspace "${id}"`)
      existing.label = workspace.label
      existing.runtime.label = workspace.label
      return existing.runtime.view()
    },
    async remove(id: string) {
      const existing = workspaces.get(id)
      if (existing === undefined)
        throw new WorkspaceError(`unknown workspace "${id}"`)
      if (workspaces.size <= 1)
        throw new WorkspaceError('cannot remove the only workspace')

      for (const server of existing.store.servers) {
        try {
          await existing.supervisor.stop(server.id)
        }
        catch {
          // Mirrors the real panel: a stubborn entry must not block the removal.
        }
      }
      await existing.supervisor.dispose()
      existing.logFiles.dispose()
      existing.ddns.dispose()
      workspaces.delete(id)

      const entry = registry.remove(id)
      fs.rmSync(workspaceDir(id), { recursive: true, force: true })
      return entry
    },
    registry,
    hub,
    reloadAll: () => {
      settings.load()
      for (const workspace of workspaces.values()) {
        workspace.store.load()
        workspace.runtime.history.load()
      }
    },
    startAll: async (ids: string[] = [...workspaces.keys()]) => {
      for (const id of ids)
        await workspaces.get(id)?.supervisor.startAll({ autostartOnly: true })
    },
    // The real `BackupSources` shape: global leaves plus one source per workspace.
    backupSources: () => ({
      globalSettingsPath: settings.path,
      globalSecretsPath: globalSecrets.path,
      tlsDir: tls.directory,
      includePaths: settings.backups.includePaths,
      workspaces: [...workspaces.values()].map(workspace => ({
        id: workspace.id,
        label: workspace.label,
        settingsPath: workspace.store.settingsPath,
        serversPath: workspace.store.path,
        secretsPath: workspace.secrets.path,
        servers: workspace.store.servers,
      })),
    }),
    dispose: async () => {
      for (const workspace of workspaces.values()) {
        await workspace.supervisor.dispose()
        workspace.logFiles.dispose()
        workspace.ddns.dispose()
      }
    },
  } as unknown as PanelService
  panelApi = panel

  const controlServer = {
    endpoint,
    rebind: async (_next: { host: Bind, port: number }) => ({ ok: true }),
    restart: async () => ({ ok: true }),
  }

  // A real proxy service over this fixture's own directory: the routes under test are
  // the panel's, and none of these tests start an engine.
  const proxy = new ProxyService({
    settings,
    binDir: path.join(hhDir, '.proxy', 'bin'),
    engineDir: path.join(hhDir, '.proxy', 'engine'),
    configPath: path.join(hhDir, '.proxy', 'engine', 'current.json'),
    previousConfigPath: path.join(hhDir, '.proxy', 'engine', 'previous.json'),
    stateDir: path.join(hhDir, '.proxy', 'state'),
    adminPath: path.join(hhDir, '.proxy', 'state', 'admin.json'),
    logDir: path.join(hhDir, '.logs'),
    tlsDir: path.join(hhDir, '.proxy', 'tls'),
    control: () => endpoint,
    resolveServer: () => null,
    exposureBlocked: () => checkProxyExposure(settings.proxy, settings.control.auth.enabled, auth.passwordSet, auth.usingDefaultPassword),
    onStateChange: () => undefined,
  })

  let shutdowns = 0
  const deps = {
    panel,
    hub,
    auth,
    secrets: globalSecrets,
    controlServer,
    tls,
    backups,
    ui,
    proxy,
    runtimeToken: 'runtime-token',
    onShutdown: async () => {
      shutdowns += 1
    },
  } as unknown as AppDeps

  const root = createRootApp(deps)
  const app = new Hono()
    .use('*', async (c, next) => {
      (c.req.raw as { ip?: string | null }).ip = options.ip ?? '127.0.0.1'
      await next()
    })
    .route('/', root)

  return {
    app,
    dir,
    settings,
    registry,
    panel,
    defaultId: registry.defaultId,
    workspaces,
    store: defaultWorkspace.store,
    secrets: defaultWorkspace.secrets,
    auth,
    logFiles: defaultWorkspace.logFiles,
    backups,
    tls,
    ui,
    hub,
    notifications: defaultWorkspace.notifications,
    ddns: defaultWorkspace.ddns,
    supervisor: defaultWorkspace.supervisor,
    controlServer,
    shutdownCalls: () => shutdowns,
    serverViews: defaultViews,
    cleanup: async () => {
      await panel.dispose()
      await fs.promises.rm(dir, { recursive: true, force: true })
    },
  }
}

/** Requests that carry a JSON body, which is most of them. */
export function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  }
}
