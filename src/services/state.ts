import type { ConfigStore } from '#src/config/store'
import type { AuthService } from '#src/services/auth'
import type { BackupService } from '#src/services/backups'
import type { ControlEndpoint } from '#src/services/control-server'
import type { HostMonitor } from '#src/services/host-monitor'
import type { NotificationService } from '#src/services/notifications'
import type { TlsStore } from '#src/services/tls'
import type { AppState, BackupsView, ControlConfig, ControlView, HostView, ServerDefaults, ServerView } from '#src/shared/contracts'
import { dataRoot, projectDir } from '#src/helpers/paths'
import { checkExposure } from '#src/services/exposure'

export interface BuildStateDeps {
  store: ConfigStore
  auth: AuthService
  control: ControlEndpoint
  tls: TlsStore
  notifications: NotificationService
  hostMonitor: HostMonitor
  backups: BackupService
  logsDir: string
  views: ServerView[]
}

/**
 * The panel's own settings are derived here — configured values from the store,
 * live values from the listener, security state from the auth service and the
 * certificate pair from disk — so the UI never has to reason about the
 * differences.
 */
export function buildControlView(
  store: ConfigStore,
  auth: AuthService,
  control: ControlEndpoint,
  tls: TlsStore,
): ControlView {
  const config: ControlConfig = store.config.control
  const exposure = checkExposure(config, auth.passwordSet, auth.usingDefaultPassword)

  return {
    label: config.label,
    port: config.port,
    host: config.host,
    bindHost: control.bindHost,
    url: control.url,
    protocol: control.protocol,
    openBrowser: config.openBrowser,
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

export function buildDefaults(store: ConfigStore): ServerDefaults {
  return store.defaults
}

export function buildBackupsView(store: ConfigStore, backups: BackupService): BackupsView {
  return {
    enabled: store.config.backups.enabled,
    dir: backups.directory,
    keep: store.config.backups.keep,
    includePaths: store.config.backups.includePaths,
    paths: backups.paths,
    files: backups.list(),
  }
}

export function buildHostView(hostMonitor: HostMonitor): HostView {
  return hostMonitor.view
}

export function buildAppState(deps: BuildStateDeps): AppState {
  return {
    control: buildControlView(deps.store, deps.auth, deps.control, deps.tls),
    defaults: buildDefaults(deps.store),
    logs: deps.store.config.logs,
    notifications: { telegram: deps.notifications.status() },
    host: buildHostView(deps.hostMonitor),
    backups: buildBackupsView(deps.store, deps.backups),
    configPath: deps.store.path,
    configError: deps.store.configError,
    projectDir,
    dataRoot,
    logsDir: deps.logsDir,
    servers: deps.views,
  }
}
