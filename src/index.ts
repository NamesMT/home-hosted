import type { AppType } from '#src/app'
import type { Runtime } from '#src/helpers/daemon'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createRootApp } from '#src/app'
import { SecretsStore } from '#src/config/secrets'
import { SEED_CONFIG } from '#src/config/seed'
import { ConfigStore } from '#src/config/store'
import { clearRuntime, isProcessAlive, newToken, readRuntime, writeRuntime } from '#src/helpers/daemon'
import { logger } from '#src/helpers/logger'
import { openBrowser } from '#src/helpers/open'
import {
  daemonLogPath,
  dataRoot,
  defaultConfigPath,
  defaultHistoryPath,
  defaultLogsDir,
  defaultSecretsPath,
  defaultTlsDir,
  projectDir,
  resolveUserPath,
} from '#src/helpers/paths'
import { resolveTemplate } from '#src/helpers/template'
import { appVersion } from '#src/helpers/version'
import { isPortFree } from '#src/providers/port'
import { AuthService, DEFAULT_PASSWORD } from '#src/services/auth'
import { BackupService, resolveBackupPaths } from '#src/services/backups'
import { ConfigWatch } from '#src/services/config-watch'
import { ControlServer } from '#src/services/control-server'
import { EventHub } from '#src/services/events'
import { checkExposure } from '#src/services/exposure'
import { HistoryStore } from '#src/services/history'
import { HostMonitor } from '#src/services/host-monitor'
import { LogFiles } from '#src/services/log-files'
import { NotificationService } from '#src/services/notifications'
import { buildAppState } from '#src/services/state'
import { Supervisor } from '#src/services/supervisor'
import { TlsStore } from '#src/services/tls'
import { UiService } from '#src/services/ui'
import { parseBind } from '#src/shared/contracts'

/** The package root: one level above this file, whether it is `src/` or `dist/`. */
export const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

function packageVersion(): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { version?: string }
    return manifest.version ?? '0.0.0'
  }
  catch {
    return '0.0.0'
  }
}

export interface ControlPlaneOptions {
  /** `--config`, or `$HHOSTED_HOME/servers.config.json`. */
  configPath?: string
  /** One-off overrides, persisted only after every guard below passes. */
  port?: number
  host?: string
  autostart: boolean
  open: boolean
  /** Print the effective config and exit without starting anything. */
  printConfig: boolean
}

/** A probe target for a `lan` bind, which is not connectable as `0.0.0.0`. */
function probeHostFor(bindHost: string): string {
  return bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost
}

/**
 * Runs the control plane in *this* process until it is stopped. `home-hosted up`
 * detaches a child that calls this; `--foreground` (systemd, docker) calls it
 * directly.
 */
export async function runControlPlane(options: ControlPlaneOptions): Promise<void> {
  const existing = readRuntime()
  if (existing !== null && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
    logger.error(`already running (pid ${existing.pid}) at ${existing.url} — run \`home-hosted down\` first`)
    process.exit(1)
  }
  if (existing !== null)
    clearRuntime()

  const configPath = options.configPath ?? defaultConfigPath
  const store = new ConfigStore(configPath, SEED_CONFIG)
  store.load()
  store.writeJsonSchema()

  // A config this release cannot read is refused rather than run with defaults: the
  // groups would fall back silently, and for `control` that means a different port,
  // bind and auth policy than the file asked for. Pinning the release that wrote it,
  // or migrating, is the way forward — see the Compatibility section of AGENTS.md.
  // Nothing is written before this point, so a refused start leaves the file alone.
  if (store.configError !== null) {
    logger.error(`refusing to start: ${store.configError}`)
    logger.info(`fix ${store.path}, or install the release that wrote it`)
    process.exit(1)
  }
  if (store.pendingMigrations.length > 0) {
    logger.error(`refusing to start: ${store.path} needs ${store.pendingMigrations.length} migration(s) before ${appVersion()} can use it`)
    logger.info('run `home-hosted migrate` to see and apply them')
    process.exit(1)
  }

  const secrets = new SecretsStore(defaultSecretsPath)
  const auth = new AuthService(secrets, () => store.config.control.auth)
  const tls = new TlsStore(defaultTlsDir)
  const logFiles = new LogFiles(defaultLogsDir, () => store.config.logs)
  const history = new HistoryStore(defaultHistoryPath)
  const notifications = new NotificationService(
    secrets,
    () => store.config.notifications,
    () => store.config.logs,
  )
  const hostMonitor = new HostMonitor(
    () => store.config.host,
    target => resolveUserPath(resolveTemplate(target, { projectDir, dataRoot, home: os.homedir() })),
    notifications,
  )
  // Restoring a backup replaces the config file, which no store write covers: the
  // hook below re-reads it and brings the restored autostart entries up, so a
  // blank instance ends up running the setup the archive carried.
  let onConfigRestored: (() => void) | undefined
  const backups = new BackupService({
    dataRoot,
    getConfig: () => store.config.backups,
    getSources: () => ({
      configPath: store.path,
      secretsPath: secrets.path,
      tlsDir: tls.directory,
      paths: resolveBackupPaths(store.servers, store.config.backups.includePaths),
    }),
    onConfigRestored: () => onConfigRestored?.(),
  })

  // Auth is on by default, so a first boot needs *a* password; the default is
  // deliberately weak and flagged, which keeps LAN/exposure binding blocked (and
  // is announced on the login page) until it is changed.
  if (!auth.passwordSet) {
    auth.ensureDefaultPassword(DEFAULT_PASSWORD)
    logger.warn(`no password was set — created the default "${DEFAULT_PASSWORD}"; change it in Settings → Authentication`)
  }

  const configured = store.config.control
  const intendedHost = options.host === undefined ? configured.host : parseBind(options.host)
  if (intendedHost === null) {
    logger.error(`invalid control host: ${String(options.host)} (expected local, lan or an ipv4 address)`)
    process.exit(1)
  }

  const intended = { host: intendedHost, port: options.port ?? configured.port }
  if (!Number.isInteger(intended.port) || intended.port <= 0 || intended.port > 65535) {
    logger.error(`invalid control port: ${String(options.port)}`)
    process.exit(1)
  }

  if (options.printConfig) {
    process.stdout.write(`${JSON.stringify(store.config, null, 2)}\n`)
    return
  }

  // Never serve the panel beyond loopback without a password behind it.
  const exposure = checkExposure({ ...configured, host: intended.host }, auth.passwordSet, auth.usingDefaultPassword)
  if (exposure.blockedReason !== null) {
    logger.error(`refusing to start: ${exposure.blockedReason}`)
    logger.info('bind the panel back to `local`, or set a password with `home-hosted set-password` and enable auth in the settings page')
    process.exit(1)
  }

  if (!(await isPortFree(intended.port))) {
    logger.error(`control port ${intended.port} is already in use — is another home-hosted running?`)
    process.exit(1)
  }

  if (intended.host !== configured.host || intended.port !== configured.port)
    store.updateControl({ host: intended.host, port: intended.port })

  const ui = new UiService({ dataRoot, stockDir: path.join(packageRoot, 'uis', 'stock', 'dist') })
  const hub = new EventHub()
  let app: AppType | undefined
  const token = newToken()

  const controlServer = new ControlServer(
    {
      fetch: (request) => {
        if (!app)
          throw new Error('the control app is not ready yet')
        return app.fetch(request)
      },
      trustProxy: () => store.config.control.auth.trustProxy,
      tls: () => (store.config.control.tls.enabled ? tls.load() : null),
    },
    { host: intended.host, port: intended.port, tls: store.config.control.tls.enabled },
  )

  const supervisor = new Supervisor(store, hub, {
    configPath: store.path,
    control: controlServer.endpoint,
    buildState: views => buildAppState({
      store,
      auth,
      control: controlServer.endpoint,
      tls,
      notifications,
      hostMonitor,
      backups,
      logsDir: logFiles.directory,
      views,
    }),
    history,
    logFiles,
    notifications,
    hostMonitor,
  })

  /**
   * A config edited by hand — a text editor, a `git checkout`, a config-management
   * tool — is picked up without a restart. A revision this release cannot read is
   * reported in the state frame and the panel keeps running what it had, so a typo
   * never stops a server. A definition that *did* change takes effect on that
   * entry's next start; a newly added entry with `autostart` starts now, the way it
   * would after a restart, and a removed one is stopped and forgotten.
   */
  let lastConfigError: string | null = store.configError
  const configWatch = new ConfigWatch({
    file: store.path,
    onChange: () => {
      const before = new Set(store.servers.map(server => server.id))
      const result = store.reloadFromDisk()

      // One line per change of state, not one per poll: the file stays bad until
      // somebody fixes it.
      if (store.configError !== lastConfigError) {
        if (store.configError === null)
          logger.info('the config file is readable again')
        else
          logger.error(`${store.configError} — keeping the config already running`)
        lastConfigError = store.configError
      }

      if (!result.applied) {
        if (result.changed && result.error === null)
          logger.info('the config file changed, but not in a way that changes the config')
        return
      }

      const added = store.servers.filter(server => !before.has(server.id))
      const removed = [...before].filter(id => !store.getServer(id))
      logger.info(`config reloaded from disk — ${store.servers.length} server(s)${added.length === 0 ? '' : `, ${added.length} added`}${removed.length === 0 ? '' : `, ${removed.length} removed`}`)

      // `--no-autostart` means "do not start anything on your own", and a reload is
      // not an exception to that.
      if (!options.autostart)
        return
      for (const server of added) {
        if (!server.autostart)
          continue
        void supervisor.start(server.id).catch((error: unknown) => {
          logger.error(`could not start the added server ${server.id}`, error)
        })
      }
    },
    onError: error => logger.warn(`cannot watch ${path.basename(store.path)} for changes: ${error instanceof Error ? error.message : String(error)}`),
  })
  configWatch.start()

  let shuttingDown = false
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown)
      return
    shuttingDown = true
    logger.info(`${reason} — stopping ${supervisor.views().length} server(s)`)
    clearRuntime()
    configWatch.dispose()
    auth.dispose()
    await supervisor.dispose()
    logFiles.dispose()
    history.dispose()
    await controlServer.close(true)
    process.exit(0)
  }

  app = createRootApp({
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
    runtimeToken: token,
    onShutdown: () => shutdown('shutdown requested locally'),
  })

  await controlServer.start()
  // Reads every existing archive once, so the first state frame already shows
  // which backups are password-protected.
  await backups.warm()

  const endpoint = controlServer.endpoint
  const runtime: Runtime = {
    version: packageVersion(),
    pid: process.pid,
    url: endpoint.url,
    probeUrl: `${endpoint.protocol}://${probeHostFor(endpoint.bindHost)}:${endpoint.port}`,
    protocol: endpoint.protocol,
    port: endpoint.port,
    bindHost: endpoint.bindHost,
    startedAt: Date.now(),
    projectDir,
    dataRoot,
    configPath: store.path,
    logFile: daemonLogPath,
    token,
  }
  writeRuntime(runtime)

  logger.box(`home-hosted ${runtime.version}\n${endpoint.url}`)
  logger.info(`config:  ${store.path}`)
  logger.info(`secrets: ${secrets.path}${auth.passwordSet ? '' : ' (no password set)'}`)
  logger.info(`auth:    ${auth.isRequired() ? 'required' : 'disabled'}${auth.usingDefaultPassword ? ' (default password)' : ''}${auth.apiTokenSet ? ' · API token set' : ''}${exposure.exposed ? ' · exposed beyond loopback' : ''}`)
  logger.info(`logs:    ${store.config.logs.persist ? `${logFiles.directory} (max ${store.config.logs.maxBytes} B x ${store.config.logs.keep})` : 'memory only'}`)
  logger.info(`project: ${projectDir}`)
  if (ui.custom) {
    const meta = ui.status().meta
    logger.warn(`custom UI in use${meta === null ? '' : ` (${meta.name}${meta.version === null ? '' : ` ${meta.version}`})`} — if it breaks, run \`home-hosted ui-revert\``)
  }
  for (const warning of store.configWarnings)
    logger.warn(warning)
  for (const entry of supervisor.views())
    logger.info(`  ${entry.id.padEnd(12)} ${entry.config.command} ${entry.config.args.join(' ')}`.trimEnd())

  if (configured.openBrowser || options.open)
    openBrowser(endpoint.url)

  if (options.autostart) {
    void supervisor.startAll({ autostartOnly: true }).catch((error: unknown) => {
      logger.error('autostart failed', error)
    })
  }

  onConfigRestored = () => {
    store.load()

    // The restored config is a config write like any other, so the exposure rule
    // applies: a backup taken from a local instance must not open a LAN panel.
    const exposure = checkExposure(store.config.control, auth.passwordSet, auth.usingDefaultPassword)
    if (exposure.blockedReason !== null) {
      logger.warn(`the restored config would expose the panel (${exposure.blockedReason}) — forcing authentication on`)
      store.updateControl({ auth: { enabled: true } })
    }

    logger.info(`config restored — ${store.servers.length} server(s) reloaded`)
    // `--no-autostart` means "do not start anything on your own", restores included.
    if (!options.autostart)
      return
    void supervisor.startAll({ autostartOnly: true }).catch((error: unknown) => {
      logger.error('could not start the restored servers', error)
    })
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}
