import type { GlobalSettingsStore } from '#src/config/settings'
import type { WorkspaceRegistry } from '#src/config/workspaces'
import type { AuthService } from '#src/services/auth'
import type { BackupService, BackupSources, BackupWorkspaceSource } from '#src/services/backups'
import type { ControlEndpoint } from '#src/services/control-server'
import type { EventHub } from '#src/services/events'
import type { HostMonitor } from '#src/services/host-monitor'
import type { ProxyService } from '#src/services/proxy'
import type { TlsStore } from '#src/services/tls'
import type { UiService } from '#src/services/ui'
import type { AppState, ServerConfig, ServerView, Workspace, WorkspaceView } from '#src/shared/contracts'
import fs from 'node:fs'
import path from 'node:path'
import { SecretsStore } from '#src/config/secrets'
import { WorkspaceStore } from '#src/config/store'
import { WorkspaceError } from '#src/config/workspaces'
import { logger } from '#src/helpers/logger'
import {
  dataRoot,
  projectDir,
  workspaceDdnsStatePath,
  workspaceDir,
  workspaceHistoryPath,
  workspaceLogsDir,
  workspaceSecretsPath,
  workspaceServersPath,
  workspaceSettingsPath,
  workspaceStateDir,
} from '#src/helpers/paths'
import { appVersion } from '#src/helpers/version'
import { ConfigWatch } from '#src/services/config-watch'
import { DdnsService } from '#src/services/ddns'
import { HistoryStore } from '#src/services/history'
import { LogFiles } from '#src/services/log-files'
import { NotificationService } from '#src/services/notifications'
import { buildControlView, buildWorkspaceView } from '#src/services/state'
import { Supervisor } from '#src/services/supervisor'

/** Everything one workspace owns at runtime, plus the objects that watch it. */
export interface WorkspaceRuntime {
  id: string
  label: string
  store: WorkspaceStore
  secrets: SecretsStore
  logFiles: LogFiles
  history: HistoryStore
  notifications: NotificationService
  ddns: DdnsService
  supervisor: Supervisor
  watches: ConfigWatch[]
  logsDir: string
  /** The config error last written to the log, so a standing typo is reported once. */
  reportedConfigError: string | null
  /** The state frame's view of this runtime, rebuilt on every read. */
  view: () => WorkspaceView
}

export interface PanelServiceOptions {
  registry: WorkspaceRegistry
  /** The panel-wide settings: listener, auth, TLS policy, host vitals, backups. */
  settings: GlobalSettingsStore
  /** The panel-wide secrets: password hash and API token. */
  secrets: SecretsStore
  auth: AuthService
  tls: TlsStore
  backups: BackupService
  ui: UiService
  hostMonitor: HostMonitor
  hub: EventHub
  /** The live listener; read lazily because it is created after this service. */
  control: () => ControlEndpoint
  /** The panel-wide reverse proxy; read lazily for the same reason. */
  proxy: () => ProxyService | null
  /** `--no-autostart` still means "start nothing on your own", reloads included. */
  autostart: boolean
  /** `--config`: the default workspace's servers file, for a launcher that pins one. */
  defaultServersPath?: string
}

const TICK_MS = 1000

/**
 * The panel process at the workspace level: one runtime per workspace, one
 * aggregate state frame, and the CRUD a workspace selector needs.
 *
 * Every workspace gets its own store, secrets, log files, history, DDNS service
 * and supervisor, so nothing an entry does can leak across the unit a person
 * chose to separate it into. Only what is genuinely panel-wide — the listener,
 * auth, TLS, host vitals, backups, UI — stays here.
 */
export class PanelService {
  private readonly runtimes = new Map<string, WorkspaceRuntime>()
  private readonly timer: NodeJS.Timeout
  private disposed = false
  private lastStateSignature = ''
  private stateScheduled = false

  constructor(private readonly options: PanelServiceOptions) {
    for (const workspace of this.options.registry.all())
      this.runtimes.set(workspace.id, this.createRuntime(workspace))

    // Config errors and warnings are reported by the caller that owns the startup
    // decision (`runControlPlane` refuses on them); repeating them here would print
    // the same line twice before the refusal.

    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => logger.error('the panel tick failed', error))
    }, TICK_MS)
    this.timer.unref()
  }

  get settings(): GlobalSettingsStore {
    return this.options.settings
  }

  get registry(): WorkspaceRegistry {
    return this.options.registry
  }

  get hub(): EventHub {
    return this.options.hub
  }

  workspaces(): WorkspaceRuntime[] {
    return [...this.runtimes.values()]
  }

  workspace(id: string): WorkspaceRuntime | undefined {
    return this.runtimes.get(id)
  }

  /** The id a workspace-scoped request without one resolves to. */
  defaultId(): string {
    const preferred = this.options.registry.defaultId
    return this.runtimes.has(preferred) ? preferred : this.runtimes.values().next().value?.id ?? ''
  }

  requireWorkspace(id?: string): WorkspaceRuntime {
    const resolved = id === undefined || id.length === 0 ? this.defaultId() : id
    const runtime = this.runtimes.get(resolved)
    if (runtime === undefined)
      throw new WorkspaceError(`unknown workspace "${id ?? resolved}"`)
    return runtime
  }

  /** Resolves a `(workspace, server)` pair, the only unique key now that ids repeat. */
  findServer(workspaceId: string, serverId: string): { workspace: WorkspaceRuntime, config: ServerConfig } | null {
    const workspace = this.runtimes.get(workspaceId)
    if (workspace === undefined)
      return null
    const config = workspace.store.getServer(serverId)
    return config === undefined ? null : { workspace, config }
  }

  serverViews(workspaceId?: string): ServerView[] {
    if (workspaceId !== undefined)
      return this.runtimes.get(workspaceId)?.supervisor.views() ?? []
    return this.workspaces().flatMap(runtime => runtime.supervisor.views())
  }

  getState(): AppState {
    const proxy = this.options.proxy()
    return {
      control: buildControlView(this.options.settings, this.options.auth, this.options.control(), this.options.tls),
      host: this.options.hostMonitor.view,
      backups: this.options.backups.view(),
      ui: this.options.ui.status(),
      workspaces: this.workspaces().map(runtime => runtime.view()),
      ...(proxy === null ? {} : { proxy: proxy.view() }),
      projectDir,
      dataRoot,
      version: appVersion(),
    }
  }

  /** The sources a backup archive is built from and restored into. */
  backupSources(): BackupSources {
    return {
      globalSettingsPath: this.options.settings.path,
      globalSecretsPath: this.options.secrets.path,
      tlsDir: this.options.tls.directory,
      includePaths: this.options.settings.backups.includePaths,
      workspaces: this.workspaces().map<BackupWorkspaceSource>(runtime => ({
        id: runtime.id,
        label: runtime.label,
        settingsPath: runtime.store.settingsPath,
        serversPath: runtime.store.path,
        secretsPath: runtime.secrets.path,
        servers: runtime.store.servers,
      })),
    }
  }

  create(input: { id?: string, label?: string }): WorkspaceView {
    const workspace = this.options.registry.create(input)
    const runtime = this.createRuntime(workspace)
    this.runtimes.set(workspace.id, runtime)
    logger.info(`workspace "${workspace.id}" created at ${workspaceDir(workspace.id)}`)
    this.scheduleState()
    return runtime.view()
  }

  rename(id: string, label: string): WorkspaceView {
    const workspace = this.options.registry.rename(id, label)
    const runtime = this.runtimes.get(id)
    if (runtime === undefined)
      throw new WorkspaceError(`unknown workspace "${id}"`)
    runtime.label = workspace.label
    this.scheduleState()
    return runtime.view()
  }

  /**
   * Stops every entry the workspace supervises — persistent ones included, because
   * deleting a workspace removes the state file its nanny would be found through —
   * and then removes its directory.
   */
  async remove(id: string): Promise<Workspace> {
    const runtime = this.runtimes.get(id)
    if (runtime === undefined)
      throw new WorkspaceError(`unknown workspace "${id}"`)
    if (this.runtimes.size <= 1)
      throw new WorkspaceError('cannot remove the only workspace')

    for (const server of runtime.store.servers) {
      try {
        await runtime.supervisor.stop(server.id)
      }
      catch (error) {
        logger.warn(`could not stop ${server.id} while removing workspace "${id}"`, error)
      }
    }
    await runtime.supervisor.dispose()
    this.disposeRuntime(runtime)
    this.runtimes.delete(id)

    const entry = this.options.registry.remove(id)
    fs.rmSync(workspaceDir(id), { recursive: true, force: true })
    logger.info(`workspace "${id}" removed`)
    this.scheduleState()
    return entry
  }

  /** Re-reads every workspace and the global settings, e.g. after a restore. */
  reloadAll(): void {
    this.options.settings.load()
    for (const runtime of this.workspaces()) {
      runtime.store.load()
      runtime.history.load()
      this.reportWorkspaceErrors(runtime.id)
    }
    this.scheduleState()
  }

  /** Starts whatever the config marks autostart, across every workspace. */
  async startAll(workspaces: string[] = this.workspaces().map(runtime => runtime.id)): Promise<void> {
    for (const id of workspaces) {
      const runtime = this.runtimes.get(id)
      if (runtime === undefined)
        continue
      try {
        await runtime.supervisor.startAll({ autostartOnly: true })
      }
      catch (error) {
        logger.error(`autostart failed for workspace "${id}"`, error)
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    clearInterval(this.timer)
    await Promise.all(this.workspaces().map(runtime => runtime.supervisor.dispose()))
    for (const runtime of this.workspaces()) this.disposeRuntime(runtime)
  }

  // ------------------------------------------------------------------ internals

  private createRuntime(workspace: Workspace): WorkspaceRuntime {
    const id = workspace.id
    fs.mkdirSync(workspaceDir(id), { recursive: true })

    const store = new WorkspaceStore(
      id,
      workspaceSettingsPath(id),
      id === this.options.registry.defaultId && this.options.defaultServersPath !== undefined
        ? this.options.defaultServersPath
        : workspaceServersPath(id),
    )
    store.load()
    store.writeJsonSchema()

    const secrets = new SecretsStore(workspaceSecretsPath(id), undefined, 'workspace')
    const logFiles = new LogFiles(workspaceLogsDir(id), () => store.logs)
    const history = new HistoryStore(workspaceHistoryPath(id))
    const notifications = new NotificationService(secrets, () => store.notifications, () => store.logs)
    const ddns = new DdnsService({
      getConfig: () => store.ddns,
      getCredentials: (accountId, provider) => secrets.getDdnsCredentials(accountId, provider)?.values ?? null,
      notifications,
      statePath: workspaceDdnsStatePath(id),
    })

    const supervisor = new Supervisor(store, this.options.hub, {
      workspaceId: id,
      configPath: store.path,
      control: this.options.control(),
      history,
      logFiles,
      notifications,
      onStateChange: () => this.scheduleState(),
      nannyDir: workspaceStateDir(id),
    })

    const runtime: WorkspaceRuntime = {
      id,
      label: workspace.label,
      store,
      secrets,
      logFiles,
      history,
      notifications,
      ddns,
      supervisor,
      watches: [],
      logsDir: logFiles.directory,
      reportedConfigError: store.configError,
      view: () => buildWorkspaceView({
        id,
        label: runtime.label,
        store,
        logsDir: logFiles.directory,
        notifications,
        ddns,
        supervisor,
      }),
    }

    runtime.watches = [
      new ConfigWatch({ file: store.path, onChange: () => this.handleConfigChange(id), onError: error => logger.warn(`cannot watch ${path.basename(store.path)}: ${error instanceof Error ? error.message : String(error)}`) }),
      new ConfigWatch({ file: store.settingsPath, onChange: () => this.handleConfigChange(id), onError: error => logger.warn(`cannot watch ${path.basename(store.settingsPath)}: ${error instanceof Error ? error.message : String(error)}`) }),
    ]
    for (const watch of runtime.watches) watch.start()

    return runtime
  }

  private disposeRuntime(runtime: WorkspaceRuntime): void {
    for (const watch of runtime.watches) watch.dispose()
    runtime.logFiles.dispose()
    runtime.history.dispose()
    runtime.ddns.dispose()
  }

  private reportWorkspaceErrors(id: string): void {
    const runtime = this.runtimes.get(id)
    if (runtime === undefined)
      return
    if (runtime.store.configError !== null)
      logger.error(`workspace "${id}": ${runtime.store.configError} — keeping the config already running`)
    for (const warning of runtime.store.configWarnings) logger.warn(`workspace "${id}": ${warning}`)
  }

  /**
   * A workspace file edited by hand is picked up without a restart. A revision
   * this release cannot read is reported in the state frame, and the workspace
   * keeps running what it had — a typo never stops a server.
   */
  private handleConfigChange(id: string): void {
    const runtime = this.runtimes.get(id)
    if (runtime === undefined)
      return

    const before = new Set(runtime.store.servers.map(server => server.id))
    const result = runtime.store.reloadFromDisk()

    // One line per change of state, not one per poll: a typo stays a typo until
    // somebody fixes it, and the watcher checks every two seconds.
    const currentError = runtime.store.configError
    if (currentError !== runtime.reportedConfigError) {
      runtime.reportedConfigError = currentError
      if (currentError === null)
        logger.info(`workspace "${id}": the config is readable again`)
      else
        logger.error(`workspace "${id}": ${currentError} — keeping the config already running`)
    }

    if (!result.applied) {
      if (result.changed && currentError === null)
        logger.info(`workspace "${id}": the config changed, but not in a way that changes it`)
      this.scheduleState()
      return
    }

    const added = runtime.store.servers.filter(server => !before.has(server.id))
    const removed = [...before].filter(serverId => !runtime.store.getServer(serverId))
    logger.info(`workspace "${id}" config reloaded — ${runtime.store.servers.length} server(s)${added.length === 0 ? '' : `, ${added.length} added`}${removed.length === 0 ? '' : `, ${removed.length} removed`}`)

    this.scheduleState()
    if (!this.options.autostart)
      return
    for (const server of added) {
      if (!server.enabled || !server.autostart)
        continue
      void runtime.supervisor.start(server.id).catch((error: unknown) => {
        logger.error(`could not start the added server ${server.id}`, error)
      })
    }
  }

  private async tick(): Promise<void> {
    if (this.disposed)
      return
    const now = Date.now()
    await this.options.hostMonitor.tick(now)
    for (const runtime of this.workspaces()) {
      // Deliberately not awaited: a provider that is slow to answer must not hold
      // up anything else.
      runtime.ddns.tick(now)
    }
    // A certificate that arrives (or expires) changes what the proxy serves on the
    // cleartext port, so the engine is re-applied when that state moves. Cheap: the
    // certificate store is read once and cached.
    const proxy = this.options.proxy()
    if (proxy !== null) {
      await proxy.sync().catch((error: unknown) => {
        logger.warn('the proxy certificate check failed', error)
      })
    }
    this.scheduleState()
  }

  /** A panel-wide service changed something the state frame carries. */
  notifyStateChange(): void {
    this.scheduleState()
  }

  /** Coalesces every signal in a turn into at most one frame. */
  private scheduleState(): void {
    if (this.stateScheduled || this.disposed)
      return
    this.stateScheduled = true
    setImmediate(() => {
      this.stateScheduled = false
      if (!this.disposed)
        this.publishState()
    })
  }

  private publishState(): void {
    const state = this.getState()
    const signature = stateSignature(state)
    if (signature === this.lastStateSignature)
      return
    this.lastStateSignature = signature
    this.options.hub.publish({ type: 'state', ts: Date.now(), state })
  }
}

/** A cheap change key: everything the UI redraws from, nothing it does not. */
function stateSignature(state: AppState): string {
  return [
    state.control.label,
    state.control.url,
    state.control.auth.exposed,
    state.control.restartRequired,
    state.control.tls.enabled,
    state.host.sampledAt,
    state.host.alerts.join(','),
    state.backups.files.length,
    state.backups.entries.length,
    // The proxy is the one panel-wide service whose live state changes on its own
    // (a start, a stop, a rejected route), so it has to be part of the signature.
    state.proxy === undefined
      ? ''
      : [
          state.proxy.config.enabled,
          state.proxy.status.state,
          state.proxy.status.pid,
          state.proxy.status.lastError ?? '',
          state.proxy.engine.installed,
          state.proxy.engine.version ?? '',
          ...state.proxy.routes.map(route => `${route.route.id}:${route.status}:${route.upstream ?? ''}`),
        ].join(':'),
    ...state.workspaces.flatMap(workspace => [
      workspace.id,
      workspace.label,
      workspace.configError ?? '',
      workspace.ddns === undefined
        ? ''
        : [workspace.ddns.running, workspace.ddns.lastRunAt, workspace.ddns.ipv4, workspace.ddns.ipv6, ...workspace.ddns.records.map(record => `${record.host}:${record.type}:${record.state}:${record.ip}`)].join(':'),
      workspace.notifications.telegram.enabled,
      workspace.notifications.telegram.tokenSet,
      ...workspace.servers.map(server => [
        server.id,
        server.status,
        server.health,
        server.portState,
        server.pid,
        server.restarts,
        server.nextRetryAt,
        server.lastError,
        server.bufferedLines,
        // A new resource sample *is* news: the UI builds its charts by sampling
        // these frames, so leaving them out of the signature means a fleet where
        // nothing structural changes emits no frames at all.
        server.responseMs,
        server.resources?.sampledAt,
      ].join(':')),
    ]),
  ].join('|')
}
