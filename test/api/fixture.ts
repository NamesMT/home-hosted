import type { AppDeps } from '#src/app'
import type { ControlEndpoint } from '#src/services/control-server'
import type { AppState, Bind, FreePortResult, LogLine, ServerConfig, ServerView } from '#src/shared/contracts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { createRootApp } from '#src/app'
import { SecretsStore } from '#src/config/secrets'
import { ConfigStore } from '#src/config/store'
import { emptyHostView } from '#src/providers/host'
import { AuthService } from '#src/services/auth'
import { BackupService } from '#src/services/backups'
import { EventHub } from '#src/services/events'
import { LogFiles } from '#src/services/log-files'
import { NotificationService } from '#src/services/notifications'
import { buildAppState } from '#src/services/state'
import { TlsStore } from '#src/services/tls'
import { UiService } from '#src/services/ui'

/**
 * The whole panel, wired the way `src/index.ts` wires it, over real stores in a temp
 * directory — plus a stand-in supervisor, because these tests are about what the routes
 * answer, not about supervising anything.
 *
 * The wrapper around the root app fakes the peer address: srvx sets `req.raw.ip` on a
 * real connection, and the loopback rules (`/_hh/shutdown`, first-time password setup)
 * are exactly what needs exercising.
 */

export interface FakeSupervisor {
  views: () => ServerView[]
  getState: () => AppState
  startAll: () => Promise<void>
  stopAll: () => Promise<void>
  start: (id: string) => Promise<{ ok: boolean, error?: string }>
  stop: (id: string) => Promise<{ ok: boolean, error?: string }>
  restart: (id: string) => Promise<{ ok: boolean, error?: string }>
  clearLogs: (id: string) => void
  logLines: (id: string, limit?: number) => LogLine[]
  freePort: (id: string) => Promise<FreePortResult>
}

export interface Fixture {
  app: Hono
  dir: string
  store: ConfigStore
  secrets: SecretsStore
  auth: AuthService
  logFiles: LogFiles
  backups: BackupService
  tls: TlsStore
  ui: UiService
  hub: EventHub
  notifications: NotificationService
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
  /** Raw entries handed to the config file before it is loaded. */
  servers?: Record<string, unknown>[]
  views?: ServerView[]
  /** Set a real password, which arms the auth guard. */
  password?: string
  /** Peer address the routes observe. */
  ip?: string | null
}

export async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-api-'))
  const file = path.join(dir, 'servers.config.json')
  await fs.promises.writeFile(file, JSON.stringify({
    control: { port: 3999 },
    servers: options.servers ?? [],
  }, null, 2))

  const store = new ConfigStore(file)
  store.load()

  const secrets = new SecretsStore(path.join(dir, '.control-secrets.json'))
  const auth = new AuthService(secrets, () => store.config.control.auth)
  if (options.password !== undefined)
    auth.setPassword(options.password)

  const tls = new TlsStore(path.join(dir, 'tls'))
  const logsDir = path.join(dir, '.logs')
  const logFiles = new LogFiles(logsDir, () => store.config.logs)
  const notifications = new NotificationService(secrets, () => store.config.notifications, () => store.config.logs)
  const hub = new EventHub()

  const stockDir = path.join(dir, 'stock')
  fs.mkdirSync(stockDir, { recursive: true })
  fs.writeFileSync(path.join(stockDir, 'index.html'), '<!doctype html><title>stock</title>')
  const ui = new UiService({ dataRoot: dir, stockDir })

  const backups = new BackupService({
    dataRoot: dir,
    getConfig: () => store.config.backups,
    getSources: () => ({ configPath: file, secretsPath: secrets.path, tlsDir: tls.directory, paths: [] }),
  })

  const endpoint: ControlEndpoint = {
    host: 'local',
    port: 3999,
    bindHost: '127.0.0.1',
    url: 'http://127.0.0.1:3999',
    protocol: 'http',
  }

  const views = options.views ?? []
  const supervisor: FakeSupervisor = {
    views: () => views,
    getState: () => buildAppState({
      store,
      auth,
      control: endpoint,
      tls,
      notifications,
      hostMonitor: { view: emptyHostView(store.config.host) } as never,
      backups,
      logsDir,
      views,
    }),
    startAll: async () => {},
    stopAll: async () => {},
    start: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    restart: async () => ({ ok: true }),
    clearLogs: () => {},
    logLines: () => [],
    freePort: async () => ({ ok: true, port: null, terminated: [], forced: [], skipped: [], free: true }),
  }

  const controlServer = {
    endpoint,
    rebind: async (_next: { host: Bind, port: number }) => ({ ok: true }),
    restart: async () => ({ ok: true }),
  }

  let shutdowns = 0
  const deps = {
    store,
    supervisor,
    hub,
    auth,
    secrets,
    controlServer,
    tls,
    logFiles,
    notifications,
    backups,
    ui,
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
    store,
    secrets,
    auth,
    logFiles,
    backups,
    tls,
    ui,
    hub,
    notifications,
    supervisor,
    controlServer,
    shutdownCalls: () => shutdowns,
    serverViews: views,
    cleanup: async () => {
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
