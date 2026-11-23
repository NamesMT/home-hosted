import type { GlobalSettingsStore } from '#src/config/settings'
import type { AuthService } from '#src/services/auth'
import type { ControlEndpoint } from '#src/services/control-server'
import type { TlsStore } from '#src/services/tls'
import type { AppState, ControlConfig, ControlView, DdnsStatus, DestinationStatusView, LogsConfig, NotificationDefaults, ProxyView, ServerDefaults, ServerOrphan, ServerView, WorkspaceView } from '#src/shared/contracts'
import { limitAllows } from '#src/helpers/workspace'
import { checkExposure } from '#src/services/exposure'

export interface WorkspaceViewSource {
  id: string
  label: string
  store: {
    path: string
    settingsPath: string
    configError: string | null
    configWarnings: string[]
    defaults: ServerDefaults
    logs: LogsConfig
  }
  logsDir: string
  notifications: { defaults: () => NotificationDefaults, destinations: () => DestinationStatusView[] }
  ddns: { view: DdnsStatus }
  supervisor: { views: () => ServerView[], orphans?: () => ServerOrphan[] }
}

/**
 * The panel's own settings are derived here — configured values from the store,
 * live values from the listener, security state from the auth service and the
 * certificate pair from disk — so the UI never has to reason about the
 * differences.
 */
export function buildControlView(
  settings: GlobalSettingsStore,
  auth: AuthService,
  control: ControlEndpoint,
  tls: TlsStore,
): ControlView {
  const config: ControlConfig = settings.control
  const exposure = checkExposure(config, auth.passwordSet, auth.usingDefaultPassword, auth.passwordTooShort)

  return {
    label: config.label,
    port: config.port,
    host: config.host,
    bindHost: control.bindHost,
    url: control.url,
    protocol: control.protocol,
    openBrowser: config.openBrowser,
    allowedHosts: config.allowedHosts,
    restartRequired: control.port !== config.port || control.host !== config.host,
    auth: {
      enabled: config.auth.enabled,
      passwordSet: auth.passwordSet,
      passwordUpdatedAt: auth.passwordUpdatedAt,
      apiTokenSet: auth.apiTokenSet,
      usingDefaultPassword: auth.usingDefaultPassword,
      exposed: exposure.exposed,
      blockedReason: exposure.blockedReason,
      sessionTtlMs: config.auth.sessionTtlMs,
      cookieSecure: config.auth.cookieSecure,
      trustProxy: config.auth.trustProxy,
      maxLoginAttempts: config.auth.maxLoginAttempts,
      lockoutMs: config.auth.lockoutMs,
    },
    tls: tls.status(config.tls.enabled),
  }
}

/** One workspace's subtree of the state frame. */
export function buildWorkspaceView(source: WorkspaceViewSource): WorkspaceView {
  const servers = source.supervisor.views()
  return {
    id: source.id,
    label: source.label,
    configPath: source.store.path,
    settingsPath: source.store.settingsPath,
    configError: source.store.configError,
    configWarnings: source.store.configWarnings,
    logsDir: source.logsDir,
    defaults: source.store.defaults,
    logs: source.store.logs,
    notifications: {
      defaults: source.notifications.defaults(),
      destinations: source.notifications.destinations(),
    },
    ddns: source.ddns.view,
    serverCount: servers.length,
    runningCount: servers.filter(server => server.status === 'running').length,
    crashedCount: servers.filter(server => server.status === 'crashed').length,
    // Optional on the source so a fixture need not implement it; the real supervisor always
    // answers, and an empty array is the honest answer for "nothing is running stray".
    orphans: source.supervisor.orphans?.() ?? [],
    servers,
  }
}

/**
 * The whole-panel snapshot, cut down to the workspaces a credential may read.
 *
 * A workspace-limited token's limit is enforced by the scope guard on every route that **names** a
 * workspace. `GET /api/state` names none — it is the panel in one payload — so the guard has nothing
 * to check it against, and the snapshot handed a `staging`-limited account `default`'s whole subtree:
 * every server's id, `config.command`, live pid and status, plus `configPath` and `logsDir`. A
 * refused account read a `default` entry's `node --api-key=SUPERSECRET` out of `/api/state` while
 * `/api/servers?workspace=default` answered it `403 TOKEN_SCOPE`.
 *
 * It is the same sentence `GET /api/metrics` and `GET /api/events` were each fixed for: "there is no
 * `?workspace=` to narrow" is true of the *query* and false of the *data*. Here the payload is the
 * full view rather than a handful of gauges, which makes it the richest way to read a workspace the
 * account may not poll.
 *
 * `limit === null` (a session, this machine, an unlimited credential) returns the snapshot untouched,
 * so a person's own panel keeps its selector and its global overview.
 */
export function narrowStateFor(state: AppState, limit: string[] | null): AppState {
  if (limit === null)
    return state
  const workspaces = state.workspaces.filter(workspace => limitAllows(limit, workspace.id))
  return {
    ...state,
    workspaces,
    ...(state.proxy === undefined ? {} : { proxy: narrowProxyFor(state.proxy, limit) }),
  }
}

/** Whether a proxy route reaches a workspace the credential may not act on. */
function routeAllowed(route: { workspace: string }, limit: string[]): boolean {
  // A route names a workspace only when it points at one of its entries: `target: "panel"` and
  // `target: "external"` describe the panel and a literal upstream, so there is no workspace to
  // narrow — the same "adds no workspace attribution" reading `backups.includePaths` gets. A route
  // that does name one names **another workspace's server id** when it is not filtered, which is
  // what the polling route refuses.
  return route.workspace.length === 0 || limitAllows(limit, route.workspace)
}

/**
 * The reverse-proxy view, cut down to the workspaces a credential may read.
 *
 * The same sentence as the two snapshots and the metrics scrape, one level down: the route table is
 * **panel-wide with an empty query**, and every row it answers names a `workspace`/`server` pair.
 * Declared panel-wide and answered whole, `GET /api/proxy` handed a `staging`-limited `read` account
 * `default`'s routes — id, public hostname, upstream and the entry each one forwards to — while
 * `GET /api/servers?workspace=default` refused it `403`. It is worse than the DNS-account picker
 * fixed beside it, because the row carries the *entry*, not only the account.
 *
 * Both halves travel: `routes` is the resolved view, `config.routes` is the stored table it is built
 * from, and filtering one alone would leave the other reporting every workspace's entries.
 */
export function narrowProxyFor(proxy: ProxyView, limit: string[] | null): ProxyView {
  if (limit === null)
    return proxy
  return {
    ...proxy,
    routes: proxy.routes.filter(view => routeAllowed(view.route, limit)),
    config: { ...proxy.config, routes: proxy.config.routes.filter(route => routeAllowed(route, limit)) },
    // The DNS-account picker is flattened across every workspace, so it lists them too.
    ...(proxy.dnsAccounts === undefined
      ? {}
      : { dnsAccounts: proxy.dnsAccounts.filter(account => limitAllows(limit, account.workspace)) }),
  }
}
