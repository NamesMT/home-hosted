import type { ResolvedGlobalConfig } from '#src/config/schema'
import type { GlobalSettingsStore } from '#src/config/settings'
import type { WorkspaceRegistry } from '#src/config/workspaces'
import type { AuthService } from '#src/services/auth'
import type { BackupService, BackupSources } from '#src/services/backups'
import type { ControlEndpoint } from '#src/services/control-server'
import type { EventHub } from '#src/services/events'
import type { HostMonitor } from '#src/services/host-monitor'
import type { ProxyService } from '#src/services/proxy'
import type { TlsStore } from '#src/services/tls'
import type { UiService } from '#src/services/ui'
import type { AppState, DdnsAccount, ProxyDnsAccountView, ServerConfig, ServerView, Workspace, WorkspaceView } from '#src/shared/contracts'
import fs from 'node:fs'
import path from 'node:path'
import { SecretsStore } from '#src/config/secrets'
import { WorkspaceStore } from '#src/config/store'
import { WorkspaceError } from '#src/config/workspaces'
import { logger } from '#src/helpers/logger'
import {
  dataRoot,
  ensureStateDir,
  projectDir,
  workspaceDdnsStatePath,
  workspaceDir,
  workspaceHistoryPath,
  workspaceLegacyDdnsStatePath,
  workspaceLogsDir,
  workspaceSecretsPath,
  workspaceServersPath,
  workspaceSettingsPath,
  workspaceStateDir,
} from '#src/helpers/paths'
import { appVersion } from '#src/helpers/version'
import { ddnsProvider } from '#src/providers/ddns'
import { entryStatePath, readEntryState, writeEntryState } from '#src/providers/entry-state'
import { buildBackupSources } from '#src/services/backups'
import { ConfigWatch } from '#src/services/config-watch'
import { DdnsService } from '#src/services/ddns'
import { checkExposure, checkProxyExposure } from '#src/services/exposure'
import { HistoryStore } from '#src/services/history'
import { LogFiles } from '#src/services/log-files'
import { NotificationService } from '#src/services/notifications'
import { buildControlView, buildWorkspaceView } from '#src/services/state'
import { Supervisor } from '#src/services/supervisor'
import { errorMessage } from '#src/shared/error-message'

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
  /** Workspaces a `remove()` has reserved but not yet dropped, counted by the last-one check. */
  private readonly removing = new Set<string>()
  private readonly timer: NodeJS.Timeout
  private disposed = false
  private lastStateSignature = ''
  private stateScheduled = false
  /** The panel-wide `settings.json`, watched like every workspace file. */
  private readonly settingsWatch: ConfigWatch
  /** The global config error last written to the log, so a standing typo is reported once. */
  private reportedSettingsError: string | null

  constructor(private readonly options: PanelServiceOptions) {
    for (const workspace of this.options.registry.all())
      this.runtimes.set(workspace.id, this.createRuntime(workspace))

    // Config errors and warnings are reported by the caller that owns the startup
    // decision (`runControlPlane` refuses on them); repeating them here would print
    // the same line twice before the refusal.

    this.reportedSettingsError = this.options.settings.configError
    this.settingsWatch = new ConfigWatch({
      file: this.options.settings.path,
      onChange: () => this.handleSettingsChange(),
      onError: error => logger.warn(`cannot watch ${path.basename(this.options.settings.path)}: ${errorMessage(error)}`),
    })
    this.settingsWatch.start()
    this.options.settings.onConflict(() => this.settingsWatch.check())

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
    // A workspace being removed takes no new work: a start accepted while its stops are awaited
    // would outlive the directory that is about to be deleted.
    if (this.removing.has(resolved))
      throw new WorkspaceError(`workspace "${resolved}" is being removed`, 'UNKNOWN_WORKSPACE')
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

  /**
   * One workspace's DDNS account, credentials included, for the panel-wide proxy.
   *
   * The account stays where it lives — a workspace owns its secrets and its
   * notification routing — so the proxy references it instead of holding a copy.
   */
  findDnsAccount(workspaceId: string, accountId: string): { workspace: WorkspaceRuntime, account: DdnsAccount, credentials: Record<string, string> | null } | null {
    const workspace = this.runtimes.get(workspaceId)
    if (workspace === undefined)
      return null
    const account = workspace.store.ddns.accounts.find(entry => entry.id === accountId)
    if (account === undefined)
      return null
    return {
      workspace,
      account,
      credentials: workspace.secrets.getDdnsCredentials(accountId, account.provider)?.values ?? null,
    }
  }

  /**
   * Every DNS account a proxy route may name, across every workspace.
   *
   * A route references `<workspace>/<account>`, so the picker needs all of them; the
   * account itself never leaves the workspace that owns it.
   */
  listDnsAccounts(): ProxyDnsAccountView[] {
    const accounts: ProxyDnsAccountView[] = []
    for (const workspace of this.runtimes.values()) {
      for (const account of workspace.store.ddns.accounts) {
        const provider = ddnsProvider(account.provider)
        accounts.push({
          workspace: workspace.id,
          account: account.id,
          provider: account.provider,
          label: account.label,
          writesTxt: provider?.challenge !== undefined,
          hasCredentials: workspace.secrets.getDdnsCredentials(account.id, account.provider) !== null,
        })
      }
    }
    return accounts
  }

  serverViews(workspaceId?: string): ServerView[] {
    if (workspaceId !== undefined)
      return this.runtimes.get(workspaceId)?.supervisor.views() ?? []
    return this.workspaces().flatMap(runtime => runtime.supervisor.views())
  }

  /**
   * The running servers of every workspace *except* `except`, so one supervisor can recognize a
   * sibling workspace's process as one the panel owns rather than a stranger to signal — and can
   * name it when it refuses.
   *
   * Read from the live views rather than from nanny state: an adopted entry has no child record,
   * and a persistent one's pid is the nanny's, whose tree the supervisor walks itself.
   */
  siblingServers(except: string): Array<{ pid: number, workspaceId: string, serverId: string }> {
    return this.workspaces()
      .filter(runtime => runtime.id !== except)
      .flatMap(runtime => runtime.supervisor.views()
        .filter(view => view.pid !== null)
        .map(view => ({ pid: view.pid!, workspaceId: runtime.id, serverId: view.id })))
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
      settingsError: this.options.settings.configError === null
        ? null
        : { message: this.options.settings.configError, path: this.options.settings.path },
    }
  }

  /** The sources a backup archive is built from and restored into. */
  backupSources(): BackupSources {
    return buildBackupSources({
      globalSettingsPath: this.options.settings.path,
      globalSecretsPath: this.options.secrets.path,
      tlsDir: this.options.tls.directory,
      registryPath: this.options.registry.path,
      includePaths: this.options.settings.backups.includePaths,
      // Live state, so a restore can say whose data it replaced under a running process.
      runningServers: () => this.workspaces().flatMap(runtime =>
        runtime.supervisor.views()
          .filter(view => view.status === 'running')
          .map(view => ({ workspaceId: runtime.id, serverId: view.id })),
      ),
      workspaces: this.workspaces().map(runtime => ({
        id: runtime.id,
        label: runtime.label,
        // The runtime's own paths, never ones re-derived from the module constants.
        settingsPath: runtime.store.settingsPath,
        serversPath: runtime.store.path,
        secretsPath: runtime.secrets.path,
        servers: runtime.store.servers,
      })),
    })
  }

  create(input: { id?: string, label?: string }): WorkspaceView {
    const { workspace, runtime } = this.addWorkspace(input)
    logger.info(`workspace "${workspace.id}" created at ${workspaceDir(workspace.id)}`)
    this.scheduleState()
    return runtime.view()
  }

  /**
   * Registers a workspace an archive brought but this host did not have, then builds
   * its runtime so the files a restore is about to write have an owner.
   *
   * Idempotent, and it never touches an existing workspace: a restore must fill one
   * that is already here, not replace its label or its runtime.
   */
  ensureWorkspace(input: { id: string, label: string }): void {
    if (this.options.registry.has(input.id))
      return
    const { workspace, runtime } = this.addWorkspace(input)
    logger.info(`workspace "${workspace.id}" restored from an archive`)
    // Its leaves were written before this ran, so `createRuntime` already loaded them —
    // which means the `reloadAll()` that follows sees no *new* ids here. Start them now,
    // for the same reason that method starts the ones it reveals.
    this.startRestored(runtime, new Set())
    this.scheduleState()
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
    if (this.removing.has(id))
      throw new WorkspaceError(`workspace "${id}" is already being removed`)
    // Reserved before the first await: two removals checking `size` and then both awaiting their
    // stops each saw a second workspace still there, and the panel ended with none.
    if (this.runtimes.size - this.removing.size <= 1)
      throw new WorkspaceError('cannot remove the only workspace')
    this.removing.add(id)

    try {
      for (const server of runtime.store.servers) {
        const stopped = await runtime.supervisor.stop(server.id).catch((error: unknown) => {
          logger.warn(`could not stop ${server.id} while removing workspace "${id}"`, error)
          return { ok: true, error: undefined } as Awaited<ReturnType<typeof runtime.supervisor.stop>>
        })
        // A pid that outlived SIGKILL is deliberately kept findable: `stopEntry` keeps its nanny state
        // file because "its pid is in the state file" is how a later boot reaches the child the stop
        // could not forward. That file lives under `workspaceDir(id)`, which the `rmSync` below deletes
        // recursively — so removing anyway would leave the process running with nothing that knows its
        // name. Refused; the person can stop it and remove the workspace afterwards.
        if (!stopped.ok && stopped.error?.includes('survived the stop'))
          throw new WorkspaceError(`cannot remove "${id}": ${stopped.error} — stop it first, or the workspace would be deleted while that process is still running and unreachable from here`)
      }

      // The registry first: a refusal there leaves the runtime, its watchers and its files intact.
      const entry = this.options.registry.remove(id)
      this.runtimes.delete(id)
      // Persistent entries too: their nanny state is under the directory deleted next, so one left
      // running here would be an orphan nothing can find.
      await runtime.supervisor.dispose({ withPersistent: true })
      this.disposeRuntime(runtime)
      fs.rmSync(workspaceDir(id), { recursive: true, force: true })
      logger.info(`workspace "${id}" removed`)
      this.scheduleState()
      return entry
    }
    finally {
      this.removing.delete(id)
    }
  }

  /**
   * Re-reads every workspace and the global settings, e.g. after a restore.
   *
   * `store.load()` resets the byte baseline the config watcher compares against, so the
   * poll that follows sees "no change" and never reaches its autostart pass. The entries
   * an archive brought therefore waited for a panel restart — which is why the start of
   * newly appeared autostart entries belongs here, the one place that knows what was new.
   */
  /**
   * Record a dump a restore staged, so this entry's next start loads it.
   *
   * Written to the entry's own state file rather than memory: the restore usually happens before the
   * entry has ever started, and a panel restart between the two must not lose the load.
   */
  stagePendingLoad(workspaceId: string, serverId: string, dumpDir: string): void {
    // The supervisor owns both the entry and its state file, so it does the writing when there is
    // one. On a blank host there is not: the restore creates the workspace, and its runtime appears
    // only when `reloadAll` runs — so the state file is written here and the supervisor picks it up
    // on the start that follows. An optional chain would silently drop the load instead.
    // Whether the supervisor can record it is not the same as whether it has an entry: a workspace
    // whose config the restore is about to write has a runtime but no entry yet, and the supervisor
    // returns silently. So the state file is the authority, written here in every case.
    const stateDir = workspaceStateDir(workspaceId)
    // The directory is created here: `writeEntryState` is best-effort and swallows a failure, so on a
    // blank host — where the workspace's `.state/` does not exist yet — the staged load vanished
    // without a word.
    ensureStateDir(stateDir)
    const statePath = entryStatePath(stateDir, serverId)
    writeEntryState(statePath, {
      ...(readEntryState(statePath) ?? { restarts: 0, bootstrapDone: false }),
      pendingLoad: dumpDir,
    })
    // And tell the supervisor, which kicks the load if the entry is already up.
    this.runtimes.get(workspaceId)?.supervisor.stagePendingLoad(serverId, dumpDir)
  }

  reloadAll(): void {
    // Through the same guard a hand edit meets, not a bare `load()`: a restored settings file that
    // would newly expose the panel (a panel route, auth off) is refused and the running settings
    // kept, exactly as if a person had written it. An applied proxy change is re-applied there too.
    this.handleSettingsChange()
    for (const runtime of this.workspaces()) {
      const before = new Set(runtime.store.servers.map(server => server.id))
      runtime.store.load()
      this.pruneLogs(runtime)
      this.reportWorkspaceErrors(runtime.id)
      this.startRestored(runtime, before)
    }
    this.scheduleState()
  }

  /**
   * Applies a lowered `logs.keep` to the files already on disk, after any reload.
   *
   * `keep` bounds the directory, not the next rotation — and a quiet entry may not fill a file for
   * days, so "I lowered it" must not mean "eventually". The HTTP settings route always did this;
   * the hand-edit paths (`handleConfigChange`, `reloadAll`) reloaded the store and stopped there, so
   * a `settings.json` edit left `.3`…`.5` sitting under a `keep: 2` that the same docs invite a
   * person to write. One derivation, called from every path that can lower it, because pruning is
   * idempotent and cheap: it is one `readdir` per workspace.
   */
  private pruneLogs(runtime: WorkspaceRuntime): void {
    try {
      runtime.logFiles.prune()
    }
    catch (error) {
      // A directory that cannot be listed is reported by the Logs page, not by a reload.
      logger.warn(`workspace "${runtime.id}": could not prune the log rotations: ${errorMessage(error)}`)
    }
  }

  /** Starts the autostart entries a reload just revealed, exactly as a hand edit would. */
  private startRestored(runtime: WorkspaceRuntime, before: Set<string>): void {
    if (!this.options.autostart)
      return
    for (const server of runtime.store.servers) {
      if (before.has(server.id) || !server.enabled || !server.autostart)
        continue
      void runtime.supervisor.start(server.id, { actor: 'boot' }).catch((error: unknown) => {
        logger.error(`could not start the restored server ${server.id}`, error)
      })
    }
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

  /** `withPersistent` reaches every workspace's supervisor: a `down` is host-wide. */
  async dispose(options: { withPersistent?: boolean } = {}): Promise<void> {
    this.disposed = true
    clearInterval(this.timer)
    this.settingsWatch.dispose()
    this.options.backups.dispose()
    await Promise.all(this.workspaces().map(runtime => runtime.supervisor.dispose(options)))
    for (const runtime of this.workspaces()) this.disposeRuntime(runtime)
  }

  // ------------------------------------------------------------------ internals

  /**
   * Builds a new workspace's directory and runtime, and registers it only once both exist. Written
   * the other way round, a directory the filesystem refused left an entry in `workspaces.json` that
   * every later `up` died on. A failure rolls back what this call made.
   */
  private addWorkspace(input: { id?: string, label?: string }): { workspace: Workspace, runtime: WorkspaceRuntime } {
    const workspace = this.options.registry.prepare(input)
    const dir = workspaceDir(workspace.id)
    const existed = fs.existsSync(dir)
    let runtime: WorkspaceRuntime | undefined
    try {
      runtime = this.createRuntime(workspace)
      this.options.registry.create(workspace)
    }
    catch (error) {
      if (runtime !== undefined) {
        void runtime.supervisor.dispose()
        this.disposeRuntime(runtime)
      }
      if (!existed)
        fs.rmSync(dir, { recursive: true, force: true })
      throw error
    }
    this.runtimes.set(workspace.id, runtime)
    return { workspace, runtime }
  }

  private createRuntime(workspace: Workspace): WorkspaceRuntime {
    const id = workspace.id
    ensureStateDir(workspaceDir(id))

    const store = new WorkspaceStore(id, workspaceSettingsPath(id), workspaceServersPath(id))
    store.load()
    store.writeJsonSchema()

    const secrets = new SecretsStore(workspaceSecretsPath(id), undefined, 'workspace')
    const logFiles = new LogFiles(workspaceLogsDir(id), () => store.logs)
    const history = new HistoryStore(workspaceHistoryPath(id))
    const notifications = new NotificationService(secrets, () => store.notifications)
    const ddns = new DdnsService({
      getConfig: () => store.ddns,
      getCredentials: (accountId, provider) => secrets.getDdnsCredentials(accountId, provider)?.values ?? null,
      notifications,
      statePath: workspaceDdnsStatePath(id),
      legacyStatePath: workspaceLegacyDdnsStatePath(id),
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
      // Lazily, so a workspace created later is still part of the answer: the runtimes map is read
      // at call time, never captured when this supervisor was built.
      siblingServers: async () => this.siblingServers(id),
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
      new ConfigWatch({ file: store.path, onChange: () => this.handleConfigChange(id), onError: error => logger.warn(`cannot watch ${path.basename(store.path)}: ${errorMessage(error)}`) }),
      new ConfigWatch({ file: store.settingsPath, onChange: () => this.handleConfigChange(id), onError: error => logger.warn(`cannot watch ${path.basename(store.settingsPath)}: ${errorMessage(error)}`) }),
    ]
    for (const watch of runtime.watches) watch.start()
    // A save refused because a file moved under it: reload now, so the retry builds on the edit.
    store.onConflict(() => {
      for (const watch of runtime.watches) watch.check()
    })

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

    // A hand edit can lower `logs.keep`; the settings route prunes at save, and this is the same
    // intent arriving through the file instead.
    this.pruneLogs(runtime)

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

  /**
   * `settings.json` edited by hand (or by `setup-temp`) is picked up without a restart, and the next
   * save builds on it instead of overwriting it. Every consumer reads the settings through a getter,
   * so the reload alone is enough — except a running proxy engine, which holds the config it was
   * last handed and is re-applied here.
   */
  private handleSettingsChange(): void {
    const settings = this.options.settings
    const proxyBefore = JSON.stringify(settings.proxy)
    const result = settings.reloadFromDisk(candidate => this.settingsRefusal(candidate))

    const currentError = settings.configError
    if (currentError !== this.reportedSettingsError) {
      this.reportedSettingsError = currentError
      if (currentError === null)
        logger.info(`${path.basename(settings.path)} is readable again`)
      else
        logger.error(`${currentError} — keeping the settings already running`)
    }
    if (result.applied)
      logger.info(`${path.basename(settings.path)} reloaded`)

    const proxy = this.options.proxy()
    if (result.applied && proxy !== null && JSON.stringify(settings.proxy) !== proxyBefore && proxy.status().state === 'running') {
      void proxy.apply().catch((error: unknown) => {
        proxy.recordError(errorMessage(error))
        logger.warn(`proxy:    could not apply the edited settings: ${errorMessage(error)}`)
      })
    }
    this.scheduleState()
  }

  /**
   * The exposure rule a settings write obeys, for an edit that arrives through the file instead: a
   * hand edit that would newly expose the live listener or a proxied panel route without a password
   * is refused. Only a *new* exposure — one already in force is the startup guard's to report.
   */
  private settingsRefusal(candidate: ResolvedGlobalConfig): string | null {
    const auth = this.options.auth
    const liveHost = this.options.control().host
    const blocked = (config: ResolvedGlobalConfig): string | null =>
      checkExposure({ ...config.control, host: liveHost }, auth.passwordSet, auth.usingDefaultPassword).blockedReason
      ?? checkProxyExposure(config.proxy, config.control.auth.enabled, auth.passwordSet, auth.usingDefaultPassword, [this.options.control().port, config.control.port])
    const next = blocked(candidate)
    return next !== null && blocked(this.options.settings.config) === null ? next : null
  }

  private async tick(): Promise<void> {
    if (this.disposed)
      return
    const now = Date.now()
    await this.options.hostMonitor.tick(now)
    // Deliberately not awaited, like DDNS below: archiving a large data path must not hold up
    // health probes or the state frame.
    this.options.backups.tick(now)
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
    // Whole, like the host view below: a hand-picked list missed `apiTokenSet`, `passwordSet` and
    // `allowedHosts`, so another tab never saw a token minted or a password set.
    JSON.stringify(state.control),
    // A broken `settings.json` appearing or being fixed is news even when nothing else moved.
    state.settingsError?.message ?? '',
    /*
     * The whole host view, not a list of its fields. Signing only `sampledAt` and `alerts` published
     * nothing when sampling was switched off — that branch of `HostMonitor.tick` changes `enabled`
     * alone — so every other tab kept drawing dials. A field this list omits is a change no client
     * sees; the measurement is in `.agentDocs/GOTCHAS.md`.
     */
    JSON.stringify(state.host),
    // The archive list and the capture entries are no longer in the frame — they are `GET
    // /api/backups`, fetched when the settings page mounts — so a new archive does not change this
    // signature. `lastAutomaticAt` and `scheduleError` are the policy facts a page still redraws from.
    state.backups.lastAutomaticAt,
    state.backups.scheduleError?.at ?? 0,
    // Which UI the panel serves. `ui.status()` reads the installed `ui.json`, so an upload
    // or a revert is news the moment it happens — and without this it was only picked up when
    // something else moved, which the host sample eventually does (up to one interval later).
    `${state.ui.custom}:${state.ui.meta?.name ?? ''}:${state.ui.meta?.version ?? ''}`,
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
    /*
     * The whole workspace view, for the reason the host view above is signed whole: a hand-picked
     * list left out `orphans`, so a stray process appearing or going published nothing.
     */
    ...state.workspaces.map(workspace => JSON.stringify(workspace)),
  ].join('|')
}
