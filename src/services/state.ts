import type { GlobalSettingsStore } from '#src/config/settings'
import type { AuthService } from '#src/services/auth'
import type { ControlEndpoint } from '#src/services/control-server'
import type { TlsStore } from '#src/services/tls'
import type { AppState, ControlConfig, ControlView, DdnsStatus, DestinationStatusView, LogsConfig, NotificationDefaults, ServerDefaults, ServerOrphan, ServerView, WorkspaceView } from '#src/shared/contracts'
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
 * to check it against, and the snapshot handed a `staging`-limited `read` account `default`'s whole
 * subtree: every server's id, `config.command`, live pid and status, plus `configPath` and `logsDir`.
 * Measured on a fixture whose `default` holds `secret-svc`, the refused account read
 * `[{"id":"secret-svc","command":"node --api-key=SUPERSECRET","pid":4242}]` out of `/api/state` while
 * `/api/servers?workspace=default` answered it `403 TOKEN_SCOPE`.
 *
 * That is the sentence `GET /api/metrics` and `GET /api/events` were each fixed for: "there is no
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
    // The proxy's DNS-account picker is flattened across every workspace, so it lists them too.
    ...(state.proxy === undefined || state.proxy.dnsAccounts === undefined
      ? {}
      : { proxy: { ...state.proxy, dnsAccounts: state.proxy.dnsAccounts.filter(account => limitAllows(limit, account.workspace)) } }),
  }
}
