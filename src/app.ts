import type { SecretsStore } from '#src/config/secrets'
import type { ConfigStore } from '#src/config/store'
import type { AuthService } from '#src/services/auth'
import type { BackupService } from '#src/services/backups'
import type { ControlServer } from '#src/services/control-server'
import type { EventHub } from '#src/services/events'
import type { LogFiles } from '#src/services/log-files'
import type { NotificationService } from '#src/services/notifications'
import type { Supervisor } from '#src/services/supervisor'
import type { TlsStore } from '#src/services/tls'
import type { UiService } from '#src/services/ui'
import { createAuthRoute } from '#src/api/auth/$.routes'
import { createBackupsRoute } from '#src/api/backups'
import { createControlRoute } from '#src/api/control'
import { createEventsRoute } from '#src/api/events'
import { createHealthRoute } from '#src/api/health'
import { createLogsRoute } from '#src/api/logs'
import { createMetricsRoute } from '#src/api/metrics'
import { createNotificationsRoute } from '#src/api/notifications'
import { createServersRoute } from '#src/api/servers/$.routes'
import { createSettingsRoute } from '#src/api/settings'
import { createStateRoute } from '#src/api/state'
import { createStaticRoute } from '#src/api/static'
import { createTlsRoute } from '#src/api/tls'
import { errorHandler } from '#src/helpers/error'
import { appFactory } from '#src/helpers/factory'
import { logger } from '#src/helpers/logger'
import { createAuthGuard } from '#src/middleware/auth'
import { setupOpenAPI } from '#src/openapi'

export interface AppDeps {
  store: ConfigStore
  supervisor: Supervisor
  hub: EventHub
  auth: AuthService
  secrets: SecretsStore
  controlServer: ControlServer
  tls: TlsStore
  logFiles: LogFiles
  notifications: NotificationService
  backups: BackupService
  ui: UiService
  /** Token for the local `down` command, and the graceful stop it asks for. */
  runtimeToken: string
  onShutdown: () => Promise<void>
}

/**
 * The root app: middleware and sub-routes only, never a handler of its own.
 *
 * The whole thing is one chained expression on purpose — that is what keeps the
 * route map in the type, which `AppType` hands to `hc<AppType>` clients and to
 * `setupOpenAPI`.
 */
export function createRootApp(deps: AppDeps) {
  const app = appFactory.createApp()
    .use('*', async (c, next) => {
      const started = Date.now()
      await next()
      logger.debug(`${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${Date.now() - started}ms`)
    })

    .onError(errorHandler)

    // Outside `/api`, so a local `down` needs no session — but it needs the token
    // from `run.json` and a loopback peer. Registered before the guard by design.
    .route('/_hh', createControlRoute(deps))

    .use('/api/*', createAuthGuard({ auth: deps.auth }))

    .route('/api', createAuthRoute(deps))
    .route('/api', createStateRoute(deps))
    .route('/api', createEventsRoute(deps))
    .route('/api', createSettingsRoute(deps))
    .route('/api', createTlsRoute(deps))
    .route('/api', createLogsRoute(deps))
    .route('/api', createNotificationsRoute(deps))
    .route('/api', createMetricsRoute(deps))
    .route('/api', createBackupsRoute(deps))
    .route('/api/servers', createServersRoute(deps))

    .route('/', createHealthRoute(deps))

  // The spec is generated from the finished route table (and must be routed
  // *before* the static catch-all, which would otherwise swallow it).
  const documented = app.route('/', setupOpenAPI(app))
  return documented.route('/', createStaticRoute({ dir: () => deps.ui.resolveDir() }))
}

/** What a typed client (`hc<AppType>`) and the OpenAPI document are built from. */
export type AppType = ReturnType<typeof createRootApp>
