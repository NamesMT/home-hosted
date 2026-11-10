import type { ChildProcess } from 'node:child_process'
import type { WorkspaceStore } from '#src/config/store'
import type { EventHub } from '#src/services/events'
import type { NotificationReason } from '#src/services/notifications'
import type { Entry, ResolvedSpawn, StartResult, SupervisorOptions } from '#src/services/supervisor/entry'
import type { HealthContext } from '#src/services/supervisor/health'
import type { PersistentContext } from '#src/services/supervisor/persistent'
import type { PortContext, SupervisedPids } from '#src/services/supervisor/port-preflight'
import type { OrphanLivenessCache } from '#src/services/supervisor/records'
import type { FreePortResult, HistoryActor, LogLine, LogStream, NannyExit, ServerOrphan, ServerStatus, ServerView } from '#src/shared/contracts'
import { missingServer } from '#src/helpers/action-result'
import { computeBackoff } from '#src/helpers/backoff'
import { logger } from '#src/helpers/logger'
import { DockerMetrics } from '#src/providers/docker'
import { clearEntryState, entryStatePath } from '#src/providers/entry-state'
import { describeNannyExit, describeSpawnError, nannyChildPid, nannyStopOptions, sweepNannySpecs } from '#src/providers/nanny'
import { isProcessAlive, killPortHolders } from '#src/providers/port'
import { ProcessSampler } from '#src/providers/proc'
import { spawnManaged, terminate, terminatePid } from '#src/providers/process'
import { dependenciesOf, dependentsOf, orderByDependencies } from '#src/services/dependencies'
import { LineSplitter, LogBuffer } from '#src/services/log-buffer'
import { refuseLingeringStack, stopComposeStack } from '#src/services/supervisor/compose'
import { createEntry, delay, isActive, isPersistentRun } from '#src/services/supervisor/entry'
import {
  awaitReadiness,
  endHealthStreak,
  endProcessReadings,
  enforceMemoryLimit,
  giveUpOnHealth,
  healthBudgetSpent,
  probeEntry,
  resetHealth,
  sampleResources,
  shouldForceRestart,
} from '#src/services/supervisor/health'
import { runPendingLoad } from '#src/services/supervisor/pending-load'
import { PersistentEntries, rememberEchoedLine } from '#src/services/supervisor/persistent'
import { freePort, preflight, supervisedPids } from '#src/services/supervisor/port-preflight'
import { forgetRecordedChild, persistEntryState, resolveRecordedChild, scanOrphans, stopOrphanProcess } from '#src/services/supervisor/records'
import { detectCompose, killBootstrap, resolveSpawn, runBootstrap } from '#src/services/supervisor/spawn'
import { buildView } from '#src/services/supervisor/view'

export { serverTemplateVars } from '#src/providers/server-vars'
export type { SiblingServer, StartResult, SupervisorOptions } from '#src/services/supervisor/entry'

/*
 * The lifecycle state machine for one workspace's entries: start, stop, restart, exit, retry, and the
 * tick that drives probes and sampling. Each concern it delegates lives in `./supervisor/`:
 * `port-preflight` (conflicts, free-port, what the panel owns), `persistent` (nannies and their logs),
 * `health` (the health trio, readiness, probes, budgets, memory ceiling, sampling), `records`
 * (entry-state file, recorded child, orphans), `spawn` (resolution, bootstrap), `compose`, `view`.
 */

const TICK_INTERVAL_MS = 1000

type Context = PortContext & HealthContext & PersistentContext

export class Supervisor {
  // Shares one process scan per second with every other workspace's sampler.
  private readonly sampler = new ProcessSampler(1000)
  /** Container readings for docker-backed entries, batched across the workspace. */
  private readonly docker = new DockerMetrics()
  private readonly entries = new Map<string, Entry>()
  private readonly ctx: Context
  private readonly persistent: PersistentEntries
  /** Processes no entry owns, refreshed by the tick; read synchronously by the state frame. */
  private orphanCache: ServerOrphan[] = []
  private readonly orphanLiveness: OrphanLivenessCache = new Map()
  /** A tick still running when the next interval fires is not joined by a second one. */
  private ticking = false
  private readonly tickTimer: NodeJS.Timeout
  /** Detaches this supervisor from the store's listener set in `dispose()`. */
  private readonly storeUnsubscribe: () => void
  private disposed = false

  constructor(
    private readonly store: WorkspaceStore,
    private readonly hub: EventHub,
    private readonly options: SupervisorOptions,
  ) {
    const ctx: Context = {
      options,
      hub,
      log: (entry, stream, text) => this.log(entry, stream, text),
      publishServer: entry => this.publishServer(entry),
      persist: entry => persistEntryState(options.nannyDir, entry),
      notify: (entry, reason, detail) => this.notify(entry, reason, detail),
      entry: id => this.entries.get(id),
      supervisedPids: () => this.supervisedPids(),
      resolveSpawn: entry => resolveSpawn(ctx, entry),
      isDisposed: () => this.disposed,
      restartInBackground: id => this.restartInBackground(id),
      stopEntry: entry => this.stopEntry(entry),
    }
    this.ctx = ctx
    this.persistent = new PersistentEntries(ctx)

    // A spec on disk belongs to a nanny that never read it (nothing of ours can be waiting yet), and it
    // holds expanded env.
    const swept = sweepNannySpecs(this.options.nannyDir)
    if (swept > 0)
      logger.warn(`removed ${swept} unread nanny spec file(s) from ${this.options.nannyDir}`)

    this.sync()
    // Kept so `dispose()` can let go: the store outlives the supervisor.
    this.storeUnsubscribe = this.store.onChange(() => this.sync())
    // A throw inside the tick must not become an unhandled rejection: on Node 24 that ends the process.
    this.tickTimer = setInterval(() => {
      if (this.ticking)
        return
      this.ticking = true
      void this.tick()
        .catch((error: unknown) => logger.error('the supervisor tick failed', error))
        .finally(() => {
          this.ticking = false
        })
    }, TICK_INTERVAL_MS)
    this.tickTimer.unref()
  }

  views(): ServerView[] {
    return [...this.entries.values()].map(entry => this.view(entry))
  }

  /**
   * Processes this panel started that no configured entry claims any more. Reported, never touched:
   * the platform may not be able to confirm a pid's identity, and a stray duplicate (two consumers of
   * one queue) is the most damaging kind. `stopOrphan` is the explicit action.
   */
  orphans(): ServerOrphan[] {
    return [...this.orphanCache]
  }

  /** Async (a birth time per pid), so it runs on the tick, never in the per-frame view. */
  private async refreshOrphans(): Promise<void> {
    this.orphanCache = await scanOrphans(this.options.nannyDir, id => this.entries.has(id), { cache: this.orphanLiveness })
  }

  /** Stops one reported orphan and reclaims its record once the pid is gone. */
  async stopOrphan(serverId: string): Promise<{ ok: boolean, error?: string }> {
    await this.refreshOrphans()
    const orphan = this.orphans().find(entry => entry.serverId === serverId)
    if (orphan === undefined)
      return { ok: false, error: `no orphaned process is running as "${serverId}"` }

    const stopped = await stopOrphanProcess(this.options.nannyDir, orphan)
    if (!stopped.ok)
      return stopped
    // The record is gone, so the cached list is already wrong; refresh before publishing.
    await this.refreshOrphans()
    logger.info(`stopped the orphaned process ${orphan.pid} (was "${serverId}")${stopped.forced.length > 0 ? ', force-killed' : ''}`)
    this.publishState()
    return { ok: true }
  }

  logLines(id: string, limit?: number): LogLine[] {
    return this.entries.get(id)?.logs.list(limit) ?? []
  }

  async startAll(options: { autostartOnly?: boolean } = {}): Promise<void> {
    // Reattaching ignores `autostartOnly`: adopting what already runs is not starting it, and an
    // unmanaged persistent entry would look like a stranger holding its port.
    for (const entry of [...this.entries.values()]) {
      if (!entry.config.persistent || isActive(entry))
        continue
      if (entry.config.enabled) {
        await this.persistent.resume(entry, undefined, true).catch((error: unknown) => {
          logger.error(`could not reattach the persistent server ${entry.config.id}`, error)
        })
        continue
      }
      // Disabled while the panel was down: adopt the leftover nanny only to stop it.
      try {
        if (await this.persistent.resume(entry, undefined, true))
          await this.stop(entry.config.id)
      }
      catch (error) {
        logger.error(`could not stop the disabled persistent server ${entry.config.id}`, error)
      }
    }

    const targets = [...this.entries.values()]
      .filter(entry => !options.autostartOnly || entry.config.autostart)
      .map(entry => entry.config)
    // Dependencies first; levels are still started concurrently.
    for (const config of orderByDependencies(targets)) {
      await this.start(config.id, { actor: 'boot' })
    }
  }

  /**
   * Stops every entry this command owns. A persistent entry is skipped unless asked, and said so, so
   * "stopped everything" is never claimed about a running server.
   */
  async stopAll(options: { withPersistent?: boolean } = {}): Promise<void> {
    const targets = orderByDependencies([...this.entries.values()].map(entry => entry.config)).reverse()
    for (const config of targets) {
      const entry = this.entries.get(config.id)
      if (entry !== undefined && entry.config.persistent && options.withPersistent !== true) {
        if (isActive(entry))
          this.log(entry, 'system', 'persistent: left running (stop it explicitly to end it)')
        continue
      }
      await this.stop(config.id)
    }
  }

  async start(id: string, options: { retry?: boolean, actor?: HistoryActor } = {}): Promise<StartResult> {
    const entry = this.entries.get(id)
    if (!entry)
      return missingServer(id)
    if (!entry.config.enabled)
      return { ok: false, error: `server "${id}" is disabled` }
    if (entry.status === 'running' || entry.status === 'starting' || entry.starting) {
      // A staged load still has to run when the entry is already up, or the dump sits there forever.
      if (entry.pendingLoad !== null)
        this.runPendingLoadInBackground(entry)
      return { ok: true }
    }
    if (entry.stopping)
      return { ok: false, error: `server "${id}" is stopping` }

    // Set before the first await, so two overlapping starts cannot both spawn.
    entry.starting = true
    // A retry is always the panel's own doing, whatever asked for the start.
    entry.actor = options.retry ? 'policy' : (options.actor ?? 'policy')
    entry.stoppedByPanel = false
    this.clearRetry(entry)
    if (!options.retry) {
      entry.restarts = 0
      // Only a start *someone asked for* ends the health sequence and its owed outcome: the force
      // restart also comes through here as `policy`, and resetting then refilled the budget forever.
      if (entry.actor !== 'policy')
        entry.healthRestarts = 0
      if (entry.actor !== 'policy')
        entry.pendingRestart = null
      resetHealth(entry)
      // The reset has to reach disk too, or the next boot resurrects the old budget.
      this.ctx.persist(entry)
    }

    // Every await below can be overtaken by a stop, a disable, a removal or a dispose; each bumps
    // `runToken`, and the start abandons its work rather than spawn behind them.
    const token = entry.runToken
    const current = (): boolean => entry.runToken === token && !this.disposed
    const task = this.runStart(entry, current)
    entry.startTask = task
    try {
      return await task
    }
    finally {
      entry.starting = false
      if (entry.startTask === task)
        entry.startTask = null
    }
  }

  private async runStart(entry: Entry, current: () => boolean): Promise<StartResult> {
    const id = entry.config.id
    const cancelled = (): StartResult => this.disposed
      ? { ok: false, error: 'supervisor is shutting down' }
      : { ok: false, error: `server "${id}" was stopped before it started` }

    await this.startDependencies(entry, current)
    if (!current())
      return cancelled()

    // Resolved once, before every branch that can leave the entry running (it reads the env file and
    // can log), so an adopted compose stack is measured as its containers too.
    const resolved = resolveSpawn(this.ctx, entry)
    detectCompose(entry, resolved)

    entry.lastError = null
    entry.status = 'starting'
    resetHealth(entry)
    this.publishServer(entry)

    // A persistent entry whose nanny is alive is reattached, not restarted.
    if (entry.config.persistent && await this.persistent.resume(entry, current))
      return { ok: true }
    if (!current())
      return cancelled()

    // The same reattach for a non-persistent child that outlived the panel — before the bootstrap,
    // because a bootstrap is work done on the way to spawning a duplicate.
    if (!entry.config.persistent) {
      const recorded = await resolveRecordedChild(this.ctx, entry)
      if (!current())
        return cancelled()
      if (recorded.kind === 'blocked')
        return { ok: false, error: recorded.error }
      if (recorded.kind === 'adopt')
        return this.adoptEntry(entry, recorded.pid, 'the child this panel started before it died is still running')
    }

    await runBootstrap(this.ctx, entry, current)
    if (!current())
      return cancelled()

    const conflict = await preflight(this.ctx, entry)
    if (!current())
      return cancelled()
    if (conflict.kind === 'blocked')
      return { ok: false, error: conflict.error }
    if (conflict.kind === 'adopt')
      return this.adoptEntry(entry, conflict.pid, `a detached restart of this entry is already serving port ${entry.config.port}`)

    const started = this.spawnEntry(entry, resolved)
    // In the background: `start` returns on spawn, and a slow restore would make it feel hung.
    if (entry.pendingLoad !== null)
      this.runPendingLoadInBackground(entry)
    return started
  }

  /** A throw from a background task is an unhandled rejection, which ends the process on Node 24. */
  private runPendingLoadInBackground(entry: Entry): void {
    void runPendingLoad(this.ctx, entry).catch((error: unknown) => {
      entry.loadingPending = false
      logger.error(`the staged load for ${entry.config.id} failed`, error)
    })
  }

  /** Marks a restored dump as waiting to load, on the entry and on disk (a panel restart must not lose it). */
  stagePendingLoad(id: string, dumpDir: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined)
      return
    entry.pendingLoad = dumpDir
    this.ctx.persist(entry)
    this.log(entry, 'system', `load: a restored dump is waiting, it runs on the next start`)
    // Already up: no later `start` is coming, so kick the load now.
    if (entry.status === 'running' && !entry.starting)
      this.runPendingLoadInBackground(entry)
  }

  async stop(id: string): Promise<StartResult> {
    const entry = this.entries.get(id)
    if (!entry)
      return missingServer(id)
    return this.stopEntry(entry)
  }

  async restart(id: string, options: { actor?: HistoryActor } = {}): Promise<StartResult> {
    // A force restart's outcome is owed, so the internal stop must not discard it; `start()` clears it
    // for a user's restart.
    const owed = this.entries.get(id)?.pendingRestart ?? null
    const stopped = await this.stop(id)
    const entry = this.entries.get(id)
    if (entry !== undefined && owed !== null && entry.pendingRestart === null)
      entry.pendingRestart = owed
    // A stop that left something running (a surviving pid, a container) is the answer: a start now
    // would spawn beside the survivor, or adopt it as if it were new.
    if (!stopped.ok)
      return stopped
    return this.start(id, options)
  }

  /** A restart the tick asked for: awaited inline it held every other entry's probes for its stop grace. */
  private restartInBackground(id: string): void {
    void this.restart(id).catch((error: unknown) => {
      logger.error(`could not restart ${id}`, error)
    })
  }

  async freePort(id: string): Promise<FreePortResult & { error?: string }> {
    const entry = this.entries.get(id)
    if (!entry) {
      const empty: FreePortResult = { ok: false, port: null, terminated: [], forced: [], skipped: [], free: false }
      return { ...empty, ...missingServer(id) }
    }
    return freePort(this.ctx, entry)
  }

  private supervisedPids(): Promise<SupervisedPids> {
    return supervisedPids(this.options.workspaceId, this.entries.values(), this.options.siblingServers)
  }

  clearLogs(id: string): void {
    const entry = this.entries.get(id)
    if (!entry)
      return
    entry.logs.clear()
    this.publishServer(entry)
  }

  /**
   * Ends this supervisor's work. Persistent entries are left running unless `withPersistent` asks —
   * `down --with-persistent` needs the stop recorded while the panel is still alive.
   */
  async dispose(options: { withPersistent?: boolean } = {}): Promise<void> {
    this.disposed = true
    clearInterval(this.tickTimer)
    this.storeUnsubscribe()
    for (const entry of this.entries.values()) this.clearRetry(entry)
    await Promise.all(
      [...this.entries.values()]
        .filter(entry => options.withPersistent === true || !entry.config.persistent)
        .map(entry => this.stopEntry(entry)),
    )
    this.persistent.dispose()
  }

  /**
   * Starts whatever this server depends on and waits until it is ready. A dependency that refuses to
   * come up is logged and skipped rather than blocking the dependent forever.
   */
  private async startDependencies(entry: Entry, current: () => boolean): Promise<void> {
    if (entry.config.dependsOn.length === 0)
      return

    for (const dependency of dependenciesOf(entry.config, this.store.servers)) {
      if (!current())
        return
      const target = this.entries.get(dependency.id)
      if (!target || !dependency.enabled)
        continue
      // A cycle: the dependency is mid-start and waiting on this entry, so waiting on it here is each
      // waiting out the other's whole start timeout. The one already waiting gets its answer from us.
      if ((target.starting || target.status === 'starting')
        && dependenciesOf(target.config, this.store.servers).some(back => back.id === entry.config.id)) {
        this.log(entry, 'system', `dependency "${dependency.id}" is starting and depends on this server — not waiting for it`)
        continue
      }

      // Start it only when it is not already on its way up — but *always* wait for it to be ready;
      // skipping the wait let a dependent serve before its dependency had bound its port.
      if (target.status !== 'running' && target.child === null) {
        this.log(entry, 'system', `starting dependency "${dependency.id}" first`)
        // Not awaited outright: a stop of this entry must not wait out the dependency's own bootstrap.
        const started = { settled: false }
        void this.start(dependency.id)
          .catch((error: unknown) => logger.error(`could not start the dependency ${dependency.id}`, error))
          .finally(() => {
            started.settled = true
          })
        while (!started.settled && current()) await delay(100)
        if (!current())
          return
      }

      const deadline = Date.now() + dependency.health.startTimeoutMs
      const isReady = (): boolean => {
        const status = this.statusOf(target)
        if (status !== 'running')
          return false
        // "Healthy" specifically: in http mode `unknown` means nobody has checked it yet. `disabled`
        // means no health check, so `running` is all there is.
        return target.health === 'healthy' || target.health === 'disabled'
      }

      while (!isReady() && Date.now() < deadline && current()) await delay(250)
      if (!current())
        return

      if (!isReady()) {
        const status = this.statusOf(target)
        this.log(entry, 'system', `dependency "${dependency.id}" is ${status}/${target.health} — starting anyway`)
      }
    }
  }

  /** Read through a method so TypeScript does not carry a stale narrowing across awaits. */
  private statusOf(entry: Entry): ServerStatus {
    return entry.status
  }

  private notify(entry: Entry, reason: NotificationReason, detail: string): void {
    this.options.notifications.notify({
      serverId: entry.config.id,
      label: entry.config.label ?? entry.config.id,
      reason,
      detail,
    })
  }

  private async stopEntry(entry: Entry): Promise<StartResult> {
    /**
     * Two stops on one entry are **one** stop, not two racing tails.
     *
     * `stopping` is a bare boolean with no owner, so it cannot express "a teardown is still running
     * even though some stop has finished". Two overlapping calls each cleared it at their own tail:
     * the first finisher dropped the flag while the second was still parked in `stopComposeStack`,
     * `start()` saw a stopped-looking entry and spawned for real, and the second tail then cleared
     * the readings, dropped that pid and published `stopped` over a live child. Joining the in-flight
     * stop removes the second tail entirely.
     *
     * Reached by a double-click on Stop, `stop-all` racing a per-entry stop, and `sync()` stopping a
     * disabled entry while a stop is already running.
     */
    if (entry.stopTask !== null)
      return entry.stopTask
    const task = this.runStop(entry)
    // Assigned after `runStop` has run synchronously up to its first await (it sets `stopping`
    // before then), so no second caller can slip in between.
    entry.stopTask = task
    try {
      return await task
    }
    finally {
      if (entry.stopTask === task)
        entry.stopTask = null
    }
  }

  private async runStop(entry: Entry): Promise<StartResult> {
    this.clearRetry(entry)
    entry.nextRetryAt = null

    // Set first: it refuses a new start while this one runs.
    entry.stopping = true
    // A start in flight is cancelled and waited out, so nothing it was about to do lands after this.
    entry.runToken += 1
    killBootstrap(entry)
    await entry.startTask?.catch(() => undefined)

    // A persistent entry this panel never attached to (`--no-autostart`, a hand edit) has no handle;
    // adopt it first, or "stopped" would be answered while the nanny kept running.
    if (entry.config.persistent && entry.child === null && entry.pid === null) {
      await this.persistent.resume(entry).catch((error: unknown) => {
        logger.error(`could not reattach the persistent server ${entry.config.id} to stop it`, error)
      })
    }

    if (entry.child === null && entry.pid === null) {
      // Nothing of ours runs, but a compose entry's server is its containers, which may still be up.
      const stack = await stopComposeStack(this.ctx, entry)
      // Cleared after the await, for the same reason as the tail below: a start accepted during the
      // teardown must be refused by `start()`, not overwritten by this branch's verdict.
      entry.stopping = false
      if (refuseLingeringStack(this.ctx, entry, stack))
        return { ok: false, error: entry.lastError! }
      entry.status = 'stopped'
      this.publishServer(entry)
      return { ok: true }
    }

    // A single stop does not cascade, but it must say who is now running without its dependency.
    const orphaned = dependentsOf(entry.config, this.store.servers)
      .filter((dependent) => {
        const state = this.entries.get(dependent.id)
        return state !== undefined && isActive(state)
      })
    if (orphaned.length > 0)
      this.log(entry, 'system', `still running and depending on this: ${orphaned.map(dependent => dependent.id).join(', ')}`)

    entry.status = 'stopping'
    this.publishServer(entry)

    // A persistent entry's server is the nanny's child; a stop the nanny cannot forward (`SIGKILL`,
    // `killGroup: false`) would leave it running, so its pid is read from the state file.
    const nannyState = isPersistentRun(entry) ? this.persistent.readState(entry.config.id) : null

    // An adopted successor is not our child: same shutdown, signalled by pid.
    const stopOptions = isPersistentRun(entry) ? nannyStopOptions(entry.config.stop) : entry.config.stop
    const outcome = entry.child === null && entry.pid !== null
      ? await terminatePid(entry.pid, stopOptions)
      : await terminate(entry.child!, stopOptions)
    if (outcome === 'force-killed')
      this.log(entry, 'system', 'force-killed after grace period')

    // The nanny is gone by now, so its recorded child is signalled only while it is provably that child.
    const nannyChild = nannyState !== null && !entry.config.stop.killGroup ? await nannyChildPid(nannyState) : null
    if (nannyChild !== null)
      await terminatePid(nannyChild, { ...entry.config.stop, killGroup: false })

    const { port, stop } = entry.config
    if (stop.killPortHolders && port !== null) {
      // Only a stranger: a port held by a server this panel supervises is never killed from here.
      const leftover = await killPortHolders(port, (await this.supervisedPids()).pids)
      if (leftover.length > 0)
        this.log(entry, 'system', `port ${port} was still held by pid ${leftover.join(', ')} — killed`)
    }

    // A pid that outlived SIGKILL keeps its records and the outcome is not dressed up as "stopped" —
    // any entry's: a spawned child that exited has had its pid cleared by `handleExit` already, and an
    // adopted one has no exit event to clear it.
    const survivor = entry.pid !== null && isProcessAlive(entry.pid)
      ? entry.pid
      : null
    const persistentRun = isPersistentRun(entry)
    if (persistentRun)
      this.persistent.finishStop(entry, survivor)

    entry.child = null
    // A SIGKILL, an adopted wrapper or a `compose up -d` from elsewhere leaves the containers up, so
    // the stack is ended too and confirmed by a fresh listing.
    const stack = await stopComposeStack(this.ctx, entry)
    // Cleared **after** the last await, never before it. Clearing both this and `child` first left a
    // window where the entry looked stopped while the teardown was still running: a `start()` accepted
    // there spawned for real, and this tail then cleared the readings — bumping the *new* run's
    // `runToken`, dropping its pid and publishing `stopped` over a live child nothing was watching,
    // so no exit event ever came. Keeping `stopping` set lets `start()`'s existing refusal cover the
    // whole window, and there is no await between this line and the writes below.
    entry.stopping = false
    endProcessReadings(entry)
    // A survivor keeps its pid and how it was run: a second stop signals it again (as a nanny's, if
    // it was one), and the entry stays active rather than looking free to start beside it.
    if (survivor !== null) {
      entry.pid = survivor
      entry.runPersistent = persistentRun
    }
    entry.nannyExit = null
    // The streak goes with the run; the verdict too, unless a survivor keeps its `conflict` outcome.
    endHealthStreak(entry)
    if (survivor === null || !entry.config.health.enabled)
      resetHealth(entry)
    // A recorded child that is gone must not be chased by a later boot; a survivor's record is kept.
    if (entry.lastChild !== null && !isProcessAlive(entry.lastChild.pid)) {
      entry.lastChild = null
      this.ctx.persist(entry)
    }
    // A container that stayed up is a refusal for the same reason a pid is.
    const lingering = refuseLingeringStack(this.ctx, entry, stack)
    if (survivor !== null)
      entry.lastError = `pid ${survivor} survived the stop`
    entry.status = survivor === null && !lingering ? 'stopped' : 'conflict'
    this.log(entry, 'system', entry.status === 'stopped' ? 'stopped' : entry.lastError!)
    this.publishServer(entry)
    return entry.status === 'stopped'
      ? { ok: true }
      : { ok: false, error: entry.lastError! }
  }

  private sync(): void {
    const wanted = new Map(this.store.servers.map(server => [server.id, server]))

    for (const [id, entry] of [...this.entries]) {
      const config = wanted.get(id)
      if (!config) {
        this.entries.delete(id)
        this.persistent.forget(id)
        // Reclaim everything keyed by the id, so a re-added id does not inherit the old server's log
        // lines, crash history or spent retry budget. Safe: a config that fails to parse keeps the
        // last trusted server list, so a bad edit does not read as "every server was removed".
        this.options.logFiles.clear(id)
        this.options.history.forget(id)
        clearEntryState(entryStatePath(this.options.nannyDir, id))
        // Flagged so the stop below cannot write them back; clearing *after* it would race a re-add.
        entry.removed = true
        void this.stopEntry(entry).catch((error: unknown) => {
          logger.error(`could not stop the removed server ${id}`, error)
        })
        continue
      }
      const bufferChanged = entry.config.logBufferLines !== config.logBufferLines
      // `persistent` takes effect on the next start; what must not linger is the tailer, and what it
      // had not read yet still belongs to this entry.
      // A live nanny keeps its tailer until its run ends (`finishStop`/`consumeExit` drain it then).
      if (entry.config.persistent && !config.persistent && entry.runPersistent !== true)
        this.persistent.drain(entry)
      entry.config = config
      if (bufferChanged) {
        const kept = entry.logs.list(config.logBufferLines)
        entry.logs = new LogBuffer(config.logBufferLines)
        entry.logs.extend(kept)
      }
      if (!config.enabled && (isActive(entry) || entry.starting)) {
        void this.stopEntry(entry).catch((error: unknown) => {
          logger.error(`could not stop the disabled server ${id}`, error)
        })
      }
    }

    for (const [id, config] of wanted) {
      if (!this.entries.has(id))
        this.entries.set(id, createEntry(config, this.options.nannyDir))
    }

    this.publishState()
  }

  /**
   * Takes over a detached successor: no spawn, no duplicate. Its output stays wherever it went, except
   * a persistent entry's, which its nanny still writes to the log file the relay follows. `reason` is
   * the only place a person sees *why* this pid is ours.
   */
  private adoptEntry(entry: Entry, pid: number, reason: string): StartResult {
    entry.adopted = true
    entry.runPersistent = entry.config.persistent
    entry.pid = pid
    entry.child = null
    entry.status = 'running'
    resetHealth(entry)
    entry.startedAt = Date.now()
    entry.lastError = null
    // History first, then this line, so the buffer stays in order.
    if (entry.config.persistent)
      this.persistent.follow(entry, true)
    this.log(entry, 'system', `adopted pid ${pid}: ${reason}`)
    this.publishServer(entry)
    return { ok: true }
  }

  /** An adopted successor disappeared: fall back to the normal lifecycle. */
  private handleAdoptedExit(entry: Entry): void {
    const adoptedPid = entry.pid
    if (entry.pid !== null)
      this.sampler.forget(entry.pid)
    // A nanny that vanished while we watched still leaves the real exit behind.
    if (isPersistentRun(entry))
      this.persistent.consumeExit(entry)
    const ranForMs = entry.nannyExit?.runtimeMs ?? (entry.startedAt === null ? 0 : Date.now() - entry.startedAt)
    const detail = entry.nannyExit === null ? 'adopted process exited' : describeNannyExit(entry.nannyExit)
    entry.nannyExit = null
    // Known gone: a pid record kept past its process is a later boot adopting a stranger.
    forgetRecordedChild(this.ctx, entry, adoptedPid)
    endProcessReadings(entry)
    resetHealth(entry)
    entry.exitCode = null
    entry.exitSignal = null
    if (!entry.removed) {
      this.options.history.record(entry.config.id, {
        type: 'exit',
        detail,
        runtimeMs: ranForMs,
      })
    }
    this.log(entry, 'system', `the adopted process is gone after ${Math.max(1, Math.round(ranForMs / 1000))}s`)
    this.afterExit(entry, detail, ranForMs, false)
  }

  private spawnEntry(entry: Entry, resolved: ResolvedSpawn): StartResult {
    // A persistent entry gets a nanny, which keeps the pipes alive when the panel is gone.
    return entry.config.persistent ? this.spawnNanny(entry, resolved) : this.spawnDirect(entry, resolved)
  }

  private spawnDirect(entry: Entry, resolved: ResolvedSpawn): StartResult {
    const { command, args, env, cwd, loggedArgs } = resolved

    this.log(entry, 'system', `start: ${command} ${loggedArgs.join(' ')}`)

    let child: ChildProcess
    try {
      child = spawnManaged({ command, args, cwd, env })
    }
    catch (error) {
      return this.failSpawn(entry, (error as Error).message)
    }

    const stdout = new LineSplitter((stream, text) => this.log(entry, stream, text))
    const stderr = new LineSplitter((stream, text) => this.log(entry, stream, text))
    child.stdout?.on('data', chunk => stdout.push('stdout', chunk))
    child.stderr?.on('data', chunk => stderr.push('stderr', chunk))

    this.attachChild(entry, child, `${command} ${args.join(' ')}`.trim(), cwd, () => {
      stdout.flush('stdout')
      stderr.flush('stderr')
    })
    return { ok: true }
  }

  /** The nanny is the child this supervisor tracks; the real exit cause is read from its state file. */
  private spawnNanny(entry: Entry, resolved: ResolvedSpawn): StartResult {
    const launched = this.persistent.launch(entry, resolved)
    if ('error' in launched)
      return this.failSpawn(entry, launched.error)
    this.attachChild(entry, launched.child, launched.detail, resolved.cwd)
    this.persistent.follow(entry)
    return { ok: true }
  }

  private failSpawn(entry: Entry, message: string): StartResult {
    entry.status = 'crashed'
    entry.lastError = message
    this.log(entry, 'system', `spawn failed: ${message}`)
    this.publishServer(entry)
    return { ok: false, error: message }
  }

  /**
   * The bookkeeping every spawn shares, plus the exit events that end it. `cwd` lets
   * `describeSpawnError` tell a missing working directory from a missing program (both `ENOENT`).
   */
  private attachChild(entry: Entry, child: ChildProcess, detail: string, cwd: string, flush?: () => void): void {
    entry.child = child
    entry.runPersistent = entry.config.persistent
    // A new run: whatever an earlier step said no longer describes it, and readiness only acts on `starting`.
    entry.status = 'starting'
    entry.lastError = null
    entry.pid = child.pid ?? null
    entry.startedAt = Date.now()
    // The durable record of a detached child. Not for a persistent entry: its nanny's state file is that record.
    if (!entry.config.persistent && child.pid !== undefined) {
      entry.lastChild = { pid: child.pid, startedAt: entry.startedAt }
      this.ctx.persist(entry)
    }
    this.options.history.record(entry.config.id, { type: 'start', detail, actor: entry.actor })
    entry.exitCode = null
    entry.exitSignal = null
    entry.nannyExit = null
    entry.lastProbeAt = 0
    resetHealth(entry)
    this.publishServer(entry)

    child.once('error', (error) => {
      // Name the program and what to check, not raw errno text.
      entry.lastError = describeSpawnError(error as NodeJS.ErrnoException, entry.config.command, cwd)
      this.log(entry, 'system', `process error: ${entry.lastError}`)
      flush?.()
      this.handleExit(entry, child, null, null)
    })

    child.once('exit', (code, signal) => {
      flush?.()
      this.handleExit(entry, child, code, signal)
    })

    void awaitReadiness(this.ctx, entry, child).catch((error: unknown) => {
      logger.error(`the readiness wait for ${entry.config.id} failed`, error)
    })
  }

  private handleExit(entry: Entry, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (entry.child !== child)
      return
    if (entry.pid !== null)
      this.sampler.forget(entry.pid)
    // A nanny's own exit code is only a mirror: the state file decides the reason.
    if (isPersistentRun(entry))
      this.persistent.consumeExit(entry)
    const nannyExit = entry.nannyExit
    entry.nannyExit = null

    entry.child = null
    endProcessReadings(entry)
    // Health describes a process; kept, a crashed server whose port a stranger holds read as green.
    resetHealth(entry)
    entry.exitCode = code
    entry.exitSignal = signal

    // Known exited: pids are recycled, and a record kept past its process is a false adoption waiting.
    forgetRecordedChild(this.ctx, entry, child.pid ?? null)

    // Both null means the process never got off the ground, so its error says more than "code null".
    const neverStarted = nannyExit !== null
      ? nannyExit.code === null && nannyExit.signal === null
      : code === null && signal === null && entry.lastError !== null
    const detail = neverStarted
      ? (entry.lastError ?? 'the entry could not start')
      // One formatter for both kinds of exit, so the same event reads the same however it was run.
      : nannyExit !== null
        ? describeNannyExit(nannyExit)
        : describeNannyExit({ code, signal, runtimeMs: 0, at: Date.now() } as NannyExit)
    const ranForMs = nannyExit?.runtimeMs ?? (entry.startedAt === null ? 0 : Date.now() - entry.startedAt)

    // Every exit feeds the rolling window, except a removed entry's: its history was reclaimed.
    if (!entry.removed) {
      this.options.history.record(entry.config.id, {
        type: 'exit',
        detail,
        runtimeMs: ranForMs,
      })
    }

    this.afterExit(entry, detail, ranForMs, neverStarted)
  }

  /** Once a process is gone, spawned or adopted: back off and retry, or record the crash. */
  private afterExit(entry: Entry, detail: string, ranForMs: number, neverStarted: boolean): void {
    const ranFor = `${Math.max(1, Math.round(ranForMs / 1000))}s`

    if (entry.stopping) {
      entry.status = 'stopped'
      this.publishServer(entry)
      return
    }

    const restart = entry.config.restart
    if (ranForMs >= restart.resetAfterMs)
      entry.restarts = 0
    // On disk before the retry decision, in case the panel dies again.
    this.ctx.persist(entry)

    this.log(entry, 'system', neverStarted ? `did not start: ${detail}` : `exited with ${detail} after ${ranFor}`)
    entry.lastError = neverStarted ? detail : `exited with ${detail}`

    if (restart.enabled && entry.restarts < restart.maxRetries) {
      entry.restarts += 1
      this.ctx.persist(entry)
      const backoffMs = computeBackoff(entry.restarts, restart)
      entry.status = 'backoff'
      entry.nextRetryAt = Date.now() + backoffMs
      this.log(entry, 'system', `restart ${entry.restarts}/${restart.maxRetries} in ${backoffMs}ms`)
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null
        void this.start(entry.config.id, { retry: true }).catch((error: unknown) => {
          logger.error(`could not restart ${entry.config.id}`, error)
        })
      }, backoffMs)
      entry.retryTimer.unref()
    }
    else {
      entry.status = 'crashed'
      entry.nextRetryAt = null
      // The crash is the answer now; a flag left standing would announce a recovery that never came.
      entry.pendingRestart = null
      entry.lastError = restart.enabled
        ? `gave up after ${restart.maxRetries} retries (${detail})`
        : `${detail} (automatic restart disabled)`
      this.log(entry, 'system', entry.lastError)
      this.options.history.record(entry.config.id, {
        type: 'crash',
        detail: entry.lastError,
        runtimeMs: ranForMs,
      })
      this.notify(entry, 'crash', entry.lastError)
    }

    this.publishServer(entry)
  }

  private async tick(): Promise<void> {
    if (this.disposed)
      return
    const now = Date.now()

    await sampleResources(this.entries.values(), this.sampler, this.docker, now)
    // A readdir and a signal-0 per orphan record; birth checks are cached (see `scanOrphans`).
    await this.refreshOrphans().catch((error: unknown) => {
      logger.warn('could not refresh the orphaned-process list', error)
    })

    // Probes run concurrently: one slow server must not delay the others' health.
    await Promise.allSettled([...this.entries.values()].map(entry => probeEntry(this.ctx, entry, now)))

    for (const entry of this.entries.values()) {
      // An adopted process is not our child, so nothing tells us it died.
      if (entry.adopted && entry.pid !== null && !isProcessAlive(entry.pid)) {
        this.handleAdoptedExit(entry)
        continue
      }
      // A restart or stop already under way (possibly one this tick began a second ago) owns the entry.
      if (entry.stopping || entry.starting)
        continue
      if (enforceMemoryLimit(this.ctx, entry))
        continue
      if (healthBudgetSpent(entry)) {
        // In the background, like the restarts: a stop waits out a grace period, and every other
        // entry's probes would wait with it.
        void giveUpOnHealth(this.ctx, entry).catch((error: unknown) => {
          logger.error(`could not stop ${entry.config.id} after its health budget ran out`, error)
        })
        continue
      }
      if (shouldForceRestart(this.ctx, entry, now)) {
        this.restartInBackground(entry.config.id)
        continue
      }
      if (entry.status === 'backoff' && entry.nextRetryAt !== null && now >= entry.nextRetryAt && entry.retryTimer === null) {
        void this.start(entry.config.id, { retry: true }).catch((error: unknown) => {
          logger.error(`could not restart ${entry.config.id}`, error)
        })
      }
    }

    this.publishState()
  }

  private clearRetry(entry: Entry): void {
    if (entry.retryTimer !== null) {
      clearTimeout(entry.retryTimer)
      entry.retryTimer = null
    }
  }

  private view(entry: Entry): ServerView {
    return buildView(entry, this.options.workspaceId, this.options.history)
  }

  private log(entry: Entry, stream: LogStream, text: string): void {
    // A removed entry's artifacts were reclaimed; the stop that follows logs to the console only.
    if (entry.removed) {
      logger.debug(`[${entry.config.id}] ${text}`)
      return
    }
    const line: LogLine = { ts: Date.now(), stream, text }
    entry.logs.push(line)
    this.options.logFiles.append(entry.config.id, line)
    // The relay reads a persistent entry's file back, so this line must be recognizable as ours.
    if (entry.config.persistent && this.options.logFiles.config.persist)
      rememberEchoedLine(entry.echoed, line)
    this.hub.publish({ type: 'log', ts: line.ts, workspaceId: this.options.workspaceId, serverId: entry.config.id, lines: [line] })
    if (stream === 'system')
      logger.debug(`[${entry.config.id}] ${text}`)
  }

  private publishServer(entry: Entry): void {
    if (!this.entries.has(entry.config.id))
      return
    this.hub.publish({
      type: 'server',
      ts: Date.now(),
      workspaceId: this.options.workspaceId,
      serverId: entry.config.id,
      server: this.view(entry),
    })
  }

  /** Signals the panel, which diffs the aggregate state and publishes at most one frame. */
  private publishState(): void {
    this.options.onStateChange()
  }
}
