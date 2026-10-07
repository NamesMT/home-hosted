import type { AppType } from '#src/app'
import type { Runtime } from '#src/helpers/daemon'
import type { NotificationEvent } from '#src/services/notifications'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createRootApp } from '#src/app'
import { ensureLayout } from '#src/config/layout'
import { SecretsStore } from '#src/config/secrets'
import { GlobalSettingsStore } from '#src/config/settings'
import { WorkspaceRegistry } from '#src/config/workspaces'
import { clearRuntime, newToken, readRuntime, runtimeIsAlive, runtimeIsGone, writeRuntime } from '#src/helpers/daemon'
import { logger } from '#src/helpers/logger'
import { openBrowser } from '#src/helpers/open'
import {
  daemonLogPath,
  dataRoot,
  globalSecretsPath,
  hhDir,
  projectDir,
  proxyAdminPath,
  proxyBinDir,
  proxyConfigPath,
  proxyEngineDir,
  proxyPreviousConfigPath,
  proxyStateDir,
  proxyTlsDir,
  resolveUserPath,
  tlsDir,
} from '#src/helpers/paths'
import { resolveTemplate } from '#src/helpers/template'
import { appVersion } from '#src/helpers/version'
import { isPortFree, listPortHolders } from '#src/providers/port'
import { AcmeChallengeService } from '#src/services/acme-challenge'
import { AuthService, DEFAULT_PASSWORD } from '#src/services/auth'
import { BackupService } from '#src/services/backups'
import { ConfigWatch } from '#src/services/config-watch'
import { ControlServer } from '#src/services/control-server'
import { EventHub } from '#src/services/events'
import { checkExposure, checkProxyExposure, proxyTrustWarning } from '#src/services/exposure'
import { HostMonitor } from '#src/services/host-monitor'
import { PanelService } from '#src/services/panel'
import { ProxyService } from '#src/services/proxy'
import { TlsStore } from '#src/services/tls'
import { UiService } from '#src/services/ui'
import { autoUpdateOfficialUi } from '#src/services/ui-update'
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
  /** `--config`, or the default workspace's `servers.config.json`. */
  configPath?: string
  /** One-off overrides, persisted only after every guard below passes. */
  port?: number
  host?: string
  autostart: boolean
  open: boolean
  /** Print the effective settings and workspaces and exit without starting anything. */
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
  // A pre-workspace `$HHOSTED_HOME` is relocated before anything reads a path.
  ensureLayout()

  const existing = readRuntime()
  // A live pid is not proof the panel is up: the OS recycles pids, and a stale record's own
  // `startedAt` is what tells this daemon from whatever inherited the number.
  if (existing !== null && existing.pid !== process.pid && await runtimeIsAlive(existing)) {
    logger.error(`already running (pid ${existing.pid}) at ${existing.url} — run \`home-hosted down\` first`)
    process.exit(1)
  }
  // Deleted only when nothing is behind the pid; see `runtimeIsGone`. Otherwise the live daemon
  // overwrites the record when it writes its own below.
  if (existing !== null && await runtimeIsGone(existing))
    clearRuntime()

  const settings = new GlobalSettingsStore()
  settings.load()
  settings.writeJsonSchema()

  // A settings file this release cannot read is refused rather than run with
  // defaults: for `control` that would mean a different port, bind and auth policy
  // than the file asked for.
  if (settings.configError !== null) {
    logger.error(`refusing to start: ${settings.configError}`)
    logger.info(`fix ${settings.path}, or install the release that wrote it`)
    process.exit(1)
  }
  if (settings.pendingMigrations.length > 0) {
    logger.error(`refusing to start: ${settings.path} needs ${settings.pendingMigrations.length} migration(s) before ${appVersion()} can use it`)
    logger.info('run `home-hosted migrate` to see and apply them')
    process.exit(1)
  }

  const registry = new WorkspaceRegistry()
  registry.load()
  if (registry.configError !== null) {
    logger.error(`refusing to start: ${registry.configError}`)
    process.exit(1)
  }

  const secrets = new SecretsStore(globalSecretsPath, undefined, 'global')
  const auth = new AuthService(secrets, () => settings.control.auth)
  const tls = new TlsStore(tlsDir)
  const hub = new EventHub()

  let app: AppType | undefined
  const token = newToken()

  const configured = settings.control
  const intendedHost = options.host === undefined ? configured.host : parseBind(options.host)
  if (intendedHost === null) {
    logger.error(`invalid control host: ${String(options.host)} (expected local, lan or an ipv4 address)`)
    process.exit(1)
  }

  // `--port`/`--host` move the *listener*, so the server is built from them rather
  // than from what is on disk — the persisted value only follows the port preflight.
  const intended = { host: intendedHost, port: options.port ?? configured.port }
  if (!Number.isInteger(intended.port) || intended.port <= 0 || intended.port > 65535) {
    logger.error(`invalid control port: ${String(options.port)}`)
    process.exit(1)
  }

  const controlServer = new ControlServer(
    {
      fetch: (request) => {
        if (!app)
          throw new Error('the control app is not ready yet')
        return app.fetch(request)
      },
      trustProxy: () => settings.control.auth.trustProxy,
      // `servable()`, not `load()`: srvx throws synchronously on a pair whose key does not match the
      // certificate, which fails the boot with a raw OpenSSL code. A rejected pair falls back to http.
      tls: () => (settings.control.tls.enabled ? tls.servable() : null),
    },
    { host: intended.host, port: intended.port, tls: settings.control.tls.enabled },
  )

  // Auth is on by default, so a first boot needs *a* password; the default is
  // deliberately weak and flagged, which keeps LAN/exposure binding blocked (and
  // is announced on the login page) until it is changed.
  if (!auth.passwordSet) {
    auth.ensureDefaultPassword(DEFAULT_PASSWORD)
    logger.warn(`no password was set — created the default "${DEFAULT_PASSWORD}"; change it in Global Settings → Authentication`)
  }

  // Never serve the panel beyond loopback without a password behind it.
  const exposure = checkExposure({ ...configured, host: intended.host }, auth.passwordSet, auth.usingDefaultPassword)
  if (exposure.blockedReason !== null) {
    logger.error(`refusing to start: ${exposure.blockedReason}`)
    logger.info('bind the panel back to `local`, or set a password with `home-hosted set-password` and enable auth in Global Settings')
    process.exit(1)
  }
  // Not a refusal: `true` has legitimate uses, and the real peer is not reachable once the header is
  // trusted. Saying so is what stops the lockout reading as a control it is not.
  const trustWarning = proxyTrustWarning({ ...configured, host: intended.host })
  if (trustWarning !== null)
    logger.warn(trustWarning)

  if (options.printConfig) {
    printEffectiveConfig(settings, registry, options)
    return
  }

  if (!(await isPortFree(intended.port))) {
    // The question this used to ask — "is another home-hosted running?" — is answerable from what
    // the probe already consulted, so it is answered rather than asked. A pid is what makes the
    // next step possible: `ps -p <pid>`, or the panel's own Free-port button.
    const holders = await listPortHolders(intended.port)
    logger.error(`control port ${intended.port} is already in use${holders.length > 0 ? ` by pid ${holders.join(', ')}` : ''} — another home-hosted, or something else on this port`)
    process.exit(1)
  }

  if (intended.host !== configured.host || intended.port !== configured.port)
    settings.updateControl({ host: intended.host, port: intended.port })

  const ui = new UiService({ dataRoot: hhDir, stockDir: path.join(packageRoot, 'uis', 'stock', 'dist') })
  // An install killed between its two renames leaves `.ui` missing and the user's copy in
  // a backup; put that back before anything reads the directory.
  const uiRecovery = ui.recover()
  if (uiRecovery.restored !== null)
    logger.warn(`ui:      restored the installed UI from ${uiRecovery.restored} — an earlier update was interrupted`)

  // The panel owns the aggregate state; host vitals fan out to every workspace's
  // notification service, so a host alert reaches whichever chats asked for one.
  let panel: PanelService | undefined
  const hostMonitor = new HostMonitor(
    () => settings.host,
    target => resolveUserPath(resolveTemplate(target, { projectDir, dataRoot, home: os.homedir() })),
    {
      notify: (event: NotificationEvent) => {
        for (const workspace of panel?.workspaces() ?? []) workspace.notifications.notify(event)
      },
    },
  )

  // The reverse proxy is created before the panel so the state frame can carry it,
  // and resolves entries through the panel lazily — the same closure trick.
  const proxy = new ProxyService({
    settings,
    binDir: proxyBinDir,
    engineDir: proxyEngineDir,
    configPath: proxyConfigPath,
    previousConfigPath: proxyPreviousConfigPath,
    stateDir: proxyStateDir,
    adminPath: proxyAdminPath,
    logDir: path.join(hhDir, '.logs'),
    tlsDir: proxyTlsDir,
    control: () => controlServer.endpoint,
    resolveServer: (workspaceId, serverId) => {
      const found = panel?.findServer(workspaceId, serverId)
      if (found === undefined || found === null)
        return null
      const view = panel?.serverViews(workspaceId).find(entry => entry.id === serverId)
      const port = view?.config.port ?? null
      if (port === null)
        return { url: null, message: `"${serverId}" has no port to forward to` }
      if (view?.status !== 'running' && view?.status !== 'starting')
        return { url: null, message: `"${workspaceId}/${serverId}" is ${view?.status ?? 'not running'}` }
      return { url: `${view.bindHost === '0.0.0.0' ? '127.0.0.1' : view.bindHost}:${port}`, message: null }
    },
    // A DNS-01 challenge writes through the workspace account the route names, so
    // the credentials never leave the workspace that owns them.
    resolveDnsAccount: (workspaceId, accountId) => {
      const found = panel?.findDnsAccount(workspaceId, accountId)
      if (found === undefined || found === null)
        return null
      return { provider: found.account.provider, credentials: found.credentials }
    },
    listDnsAccounts: () => panel?.listDnsAccounts() ?? [],
    defaultWorkspaceId: () => registry.defaultId,
    exposureBlocked: () => checkProxyExposure(settings.proxy, settings.control.auth.enabled, auth.passwordSet, auth.usingDefaultPassword),
    onStateChange: () => panel?.notifyStateChange(),
  })

  // The backups service needs the panel's sources, and the panel needs the
  // backups service for its state frame — one closure bridges the pair.
  const backups = new BackupService({
    dataRoot: hhDir,
    getConfig: () => settings.backups,
    getSources: () => panel!.backupSources(),
    onRestored: () => panel?.reloadAll(),
  })

  panel = new PanelService({
    registry,
    settings,
    secrets,
    auth,
    tls,
    backups,
    ui,
    hostMonitor,
    hub,
    control: () => controlServer.endpoint,
    proxy: () => proxy,
    autostart: options.autostart,
    ...(options.configPath === undefined ? {} : { defaultServersPath: options.configPath }),
  })

  // A workspace's files are configs like any other, so a bad one refuses the
  // start too — the same rule the global settings and the registry just obeyed.
  // Checked before the listener binds or `run.json` exists, so a refused start
  // leaves no trace of a panel that pretends to supervise nothing.
  for (const workspace of panel.workspaces()) {
    const store = workspace.store
    if (store.configError !== null) {
      logger.error(`refusing to start: workspace "${workspace.id}": ${store.configError}`)
      logger.info(`fix ${store.path} and ${store.settingsPath}, or install the release that wrote them`)
      process.exit(1)
    }
    if (store.pendingMigrations.length > 0) {
      logger.error(`refusing to start: workspace "${workspace.id}" needs ${store.pendingMigrations.length} migration(s) before ${appVersion()} can use it`)
      logger.info('run `home-hosted migrate` to see and apply them')
      process.exit(1)
    }
  }

  let shuttingDown = false
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown)
      return
    shuttingDown = true
    logger.info(`${reason} — stopping ${panel!.serverViews().length} server(s) across ${panel!.workspaces().length} workspace(s)`)
    if (proxy.status().state === 'running')
      logger.info('reverse proxy: left running (stop it from the panel, or switch the proxy off first)')
    clearRuntime()
    auth.dispose()
    proxy.dispose()
    await panel!.dispose()
    await controlServer.close(true)
    process.exit(0)
  }

  app = createRootApp({
    panel,
    hub,
    auth,
    secrets,
    controlServer,
    tls,
    backups,
    ui,
    proxy,
    // Credentials are read per request, so a panel with DNS-01 off never writes the
    // file — and one that switches it on picks the new pair up without a restart.
    challenge: new AcmeChallengeService({
      auth: () => (proxy.config.dns01.enabled ? proxy.challengeAuth() : null),
      accountFor: fqdn => proxy.challengeAccount(fqdn),
      onResult: (result) => {
        if (!result.ok)
          logger.warn(`proxy:    the DNS-01 challenge for ${result.fqdn} failed (${result.action}): ${result.message}`)
      },
    }),
    runtimeToken: token,
    onShutdown: () => shutdown('shutdown requested locally'),
  })

  await controlServer.start()
  // Reads every existing archive once, so the first state frame already shows
  // which backups are password-protected.
  await backups.warm()
  // Reattach to an engine that outlived the panel, or start the one this config asks for.
  await proxy.initialize()

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
    configPath: hhDir,
    logFile: daemonLogPath,
    token,
  }
  writeRuntime(runtime)

  logger.box(`home-hosted ${runtime.version}\n${endpoint.url}`)
  logger.info(`state:   ${hhDir}`)
  logger.info(`settings: ${settings.path}${auth.passwordSet ? '' : ' (no password set)'}`)
  logger.info(`auth:    ${auth.isRequired() ? 'required' : 'disabled'}${auth.usingDefaultPassword ? ' (default password)' : ''}${auth.apiTokenSet ? ' · API token set' : ''}${exposure.exposed ? ' · exposed beyond loopback' : ''}`)
  logger.info(`project: ${projectDir}`)
  for (const workspace of panel.workspaces()) {
    logger.info(`workspace ${workspace.id} "${workspace.label}" — ${workspace.store.servers.length} server(s) · ${workspace.logsDir}`)
    if (workspace.store.configError !== null)
      logger.error(`workspace ${workspace.id}: ${workspace.store.configError}`)
    for (const warning of workspace.store.configWarnings) logger.warn(`workspace ${workspace.id}: ${warning}`)
  }
  for (const warning of settings.configWarnings) logger.warn(warning)
  if (ui.custom) {
    const meta = ui.status().meta
    logger.warn(`custom UI in use${meta === null ? '' : ` (${meta.name}${meta.version === null ? '' : ` ${meta.version}`})`} — if it breaks, run \`home-hosted ui-revert\``)
    autoUpdateOfficialUi(ui, runtime.version)
  }
  for (const workspace of panel.workspaces()) {
    for (const entry of workspace.supervisor.views())
      logger.info(`  ${`${workspace.id}/${entry.id}`.padEnd(24)} ${entry.config.command} ${entry.config.args.join(' ')}`.trimEnd())
  }

  if (configured.openBrowser || options.open)
    openBrowser(endpoint.url)

  if (options.autostart) {
    void panel.startAll().catch((error: unknown) => {
      logger.error('autostart failed', error)
    })
  }

  // A failure while tearing down must still end the process: a rejected promise
  // here would leave the panel half-stopped.
  const onSignal = (signal: string): void => {
    void shutdown(signal).catch((error: unknown) => {
      logger.error(`shutdown after ${signal} failed`, error)
      process.exit(1)
    })
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))
}

/** `--print-config`: the global settings and every workspace, without starting anything. */
function printEffectiveConfig(settings: GlobalSettingsStore, registry: WorkspaceRegistry, options: ControlPlaneOptions): void {
  const workspaces = registry.all().map((workspace) => {
    const dir = path.join(hhDir, workspace.id)
    const read = (name: string): unknown => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      }
      catch {
        return null
      }
    }
    const serversFile = workspace.id === registry.defaultId && options.configPath !== undefined
      ? options.configPath
      : path.join(dir, 'servers.config.json')
    let servers: unknown = null
    try {
      servers = JSON.parse(fs.readFileSync(serversFile, 'utf8'))
    }
    catch {
      servers = null
    }
    return { id: workspace.id, label: workspace.label, settings: read('settings.json'), servers }
  })

  process.stdout.write(`${JSON.stringify({ settings: settings.rawConfig, workspaces }, null, 2)}\n`)
}

export { ConfigWatch }
