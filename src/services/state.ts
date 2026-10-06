import type { GlobalSettingsStore } from '#src/config/settings'
import type { AuthService } from '#src/services/auth'
import type { BackupService } from '#src/services/backups'
import type { ControlEndpoint } from '#src/services/control-server'
import type { TlsStore } from '#src/services/tls'
import type { ControlConfig, ControlView, DdnsStatus, LogsConfig, ServerDefaults, ServerView, TelegramStatus, WorkspaceView } from '#src/shared/contracts'
import { dataRoot, projectDir } from '#src/helpers/paths'
import { appVersion } from '#src/helpers/version'
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
  notifications: { status: () => TelegramStatus }
  ddns: { view: DdnsStatus }
  supervisor: { views: () => ServerView[] }
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

export function buildBackupsView(backups: BackupService): ReturnType<BackupService['view']> {
  return backups.view()
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
    notifications: { telegram: source.notifications.status() },
    ddns: source.ddns.view,
    serverCount: servers.length,
    runningCount: servers.filter(server => server.status === 'running').length,
    crashedCount: servers.filter(server => server.status === 'crashed').length,
    servers,
  }
}

export { appVersion, dataRoot, projectDir }
