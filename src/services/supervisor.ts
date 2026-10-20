import type { ChildProcess } from 'node:child_process'
import type { WorkspaceStore } from '#src/config/store'
import type { TemplateVars } from '#src/helpers/template'
import type { SpawnInfo } from '#src/providers/identity'
import type { ControlEndpoint } from '#src/services/control-server'
import type { EventHub } from '#src/services/events'
import type { HistoryStore } from '#src/services/history'
import type { LogFiles } from '#src/services/log-files'
import type { NotificationReason, NotificationService } from '#src/services/notifications'
import type { FreePortResult, HealthState, HistoryActor, LogLine, LogStream, NannyExit, NannySpec, PortState, ProcessResources, ServerConfig, ServerOrphan, ServerStatus, ServerView } from '#src/shared/contracts'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { missingServer } from '#src/helpers/action-result'
import { computeBackoff } from '#src/helpers/backoff'
import { bindHost, displayHost, lanAddress } from '#src/helpers/bind'
import { expandEnvList, expandEnvRecord, loadEnvFile, resolveEnvFilePath } from '#src/helpers/env-file'
import { logger } from '#src/helpers/logger'
import { dataRoot, projectDir } from '#src/helpers/paths'
import { nannyArgv } from '#src/helpers/runtime'
import { resolveRecord, resolveTemplates } from '#src/helpers/template'
import { clearEntryState, entryStatePath, readEntryState, writeEntryState } from '#src/providers/entry-state'
import { probeHealth } from '#src/providers/health-check'
import { identifyHolders } from '#src/providers/identity'
import {
  clearNannySpec,
  clearNannyState,
  describeNannyExit,
  describeSpawnError,
  nannyEntryPoint,
  nannyIsAlive,
  nannyLogFile,
  nannySpecPath,
  nannyStatePath,
  readNannyState,
  sweepNannySpecs,
  writeNannySpec,
} from '#src/providers/nanny'
import { findDockerPortHolder, isPortFree, isProcessAlive, killPortHolders, listPortHolders, probePort, processLiveness, releaseDockerPort, terminatePids } from '#src/providers/port'
import { processCarriesServerId, ProcessSampler, processTreePids } from '#src/providers/proc'
import { resolveCommand, resolveCwd, spawnManaged, terminate, terminatePid } from '#src/providers/process'
import { dependenciesOf, dependentsOf, orderByDependencies } from '#src/services/dependencies'
import { LineSplitter, LogBuffer } from '#src/services/log-buffer'
import { LogRelay } from '#src/services/log-relay'

export interface SupervisorOptions {
  /** The workspace this supervisor supervises; every view is tagged with it. */
  workspaceId: string
  configPath: string
  /** Live listener info, mutated by the control server when it rebinds. */
  control: ControlEndpoint
  history: HistoryStore
  logFiles: LogFiles
  notifications: NotificationService
  /**
   * Called when this workspace's state would have changed. The panel owns the
   * aggregate frame (it is the only thing that can see every workspace), so the
   * supervisor only signals — it never builds or publishes the snapshot itself.
   */
  onStateChange: () => void
  /** Where a persistent entry's nanny keeps its state; injected for the same reason. */
  nannyDir: string
}

/** Uptime/crash counters are reported over this window. */
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000
const HISTORY_CACHE_MS = 5000

export interface StartResult {
  ok: boolean
  error?: string
}

/** What the port preflight found: nothing in the way, our own successor, or a blocker. */
type PreflightConflict
  = | { kind: 'free' }
    | { kind: 'adopt', pid: number }
    | { kind: 'blocked', error: string }

/** What this entry's own state file says about the child the last panel spawned. */
type RecordedChild
  = | { kind: 'none' }
    | { kind: 'adopt', pid: number }
    | { kind: 'blocked', error: string }

interface Entry {
  config: ServerConfig
  status: ServerStatus
  health: HealthState
  portState: PortState
  child: ChildProcess | null
  pid: number | null
  startedAt: number | null
  /**
   * The last non-persistent child this panel spawned: a detached child outlives a panel
   * killed hard, and this is the only trace of it. Always null for a persistent entry —
   * its nanny's state file is that record, and two records would disagree.
   */
  lastChild: { pid: number, startedAt: number } | null
  exitCode: number | null
  exitSignal: string | null
  restarts: number
  /**
   * Force restarts spent on the current unhealthy sequence, bounded by `restart.maxRetries`.
   *
   * The crash path had a budget from the start; the health path had none, so an entry that stayed
   * up but failed every probe was restarted forever — 16 times in a minute in the operator audit.
   */
  healthRestarts: number
  lastError: string | null
  nextRetryAt: number | null
  retryTimer: NodeJS.Timeout | null
  healthFailures: number
  unhealthySince: number | null
  /**
   * A force restart (health timeout, memory ceiling) whose outcome has not been announced
   * yet, with the cause it was forced for. It is remembered rather than inferred from
   * `health` because the restart itself resets health to `unknown`, so the old
   * `unhealthy -> healthy` transition never happens and a successful recovery sent nothing.
   */
  pendingRestart: { cause: string } | null
  lastProbeAt: number
  lastOccupancyProbeAt: number
  probing: boolean
  /** The running process is a detached successor we adopted, not a child we spawned. */
  adopted: boolean
  /** The panel stopped this entry because it could not serve — not the operator. */
  stoppedByPanel: boolean
  /**
   * How the child of a persistent entry ended, read from its nanny's state file: the
   * panel was not its parent, so `code`/`signal` of the *nanny* are only a mirror.
   */
  nannyExit: NannyExit | null
  /** A start is in flight (set synchronously, unlike `status`). */
  starting: boolean
  stopping: boolean
  /** Who asked for the start in flight, recorded on its history event. */
  actor: HistoryActor
  /**
   * The config no longer lists this entry, so the stop that follows must not write its
   * last lines back into a log file or history that were just reclaimed for this id.
   */
  removed: boolean
  bootstrapDone: boolean
  logs: LogBuffer
  /**
   * Identity of the lines this panel wrote itself for a persistent entry. Its nanny
   * appends to the same file, so the relay reads them back and must not push them twice.
   */
  echoed: Set<string>
  responseMs: number | null
  resources: ProcessResources | null
  resourcesSampledAt: number
  historyCache: { revision: number, at: number, summary: ServerView['history'] } | null
}

const TICK_INTERVAL_MS = 1000
const PORT_STATE_INTERVAL_MS = 10000
const PORT_RELEASE_RECHECK_MS = 300
const RESOURCE_SAMPLE_INTERVAL_MS = 5000

/** History a panel attaches with, so a persistent entry's live view is not blank. */
const PERSISTENT_BACKFILL_LINES = 200

/** Echoes are read within a poll or two of being written; a bounded set is plenty. */
const ECHOED_LINE_LIMIT = 100

/** One line's exact identity: a timestamp this panel minted, its stream and its text. */
function echoedKey(line: LogLine): string {
  return `${line.ts}\u0000${line.stream}\u0000${line.text}`
}

function rememberEchoedLine(set: Set<string>, line: LogLine): void {
  set.add(echoedKey(line))
  while (set.size > ECHOED_LINE_LIMIT)
    set.delete(set.values().next().value as string)
}

/** True when this line is this panel's own echo, so it is only ever reported once. */
function forgetEchoedLine(set: Set<string>, line: LogLine): boolean {
  return set.delete(echoedKey(line))
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The placeholder set every server entry can use; shared with path resolvers. */
export function serverTemplateVars(config: ServerConfig): TemplateVars {
  return {
    id: config.id,
    label: config.label ?? config.id,
    port: config.port ?? '',
    host: bindHost(config.bind),
    displayHost: displayHost(config.bind),
    bind: config.bind,
    lanIp: lanAddress() ?? '127.0.0.1',
    cwd: resolveCwd(config.cwd),
    projectDir,
    dataRoot,
    home: os.homedir(),
  }
}

export class Supervisor {
  private readonly sampler = new ProcessSampler()
  /**
   * Live output of persistent entries. A normal entry's logs arrive down the pipe the
   * panel owns; a persistent one's are written by its nanny, so they are read back.
   */
  private readonly relay = new LogRelay({
    onLines: (serverId, lines) => this.ingestExternalLines(serverId, lines),
  })

  private readonly entries = new Map<string, Entry>()
  /** Processes no entry owns, refreshed by the tick; read synchronously by the state frame. */
  private orphanCache: ServerOrphan[] = []
  private readonly tickTimer: NodeJS.Timeout
  /** Detaches this supervisor from the store's listener set in `dispose()`. */
  private readonly storeUnsubscribe: () => void
  private disposed = false

  constructor(
    private readonly store: WorkspaceStore,
    private readonly hub: EventHub,
    private readonly options: SupervisorOptions,
  ) {
    // A spec on disk belongs to a nanny that never read it: nothing this process has
    // spawned yet can be waiting for one, and it holds expanded env.
    const swept = sweepNannySpecs(this.options.nannyDir)
    if (swept > 0)
      logger.warn(`removed ${swept} unread nanny spec file(s) from ${this.options.nannyDir}`)

    this.sync()
    // Kept so `dispose()` can let go: the store outlives the supervisor (a removed
    // workspace's store is still referenced while the panel tears it down), and a
    // discarded unsubscribe leaves the disposed supervisor and its buffers reachable.
    this.storeUnsubscribe = this.store.onChange(() => this.sync())
    // A throw inside the tick must not become an unhandled rejection: on Node 24
    // that ends the process, and this timer is what keeps every server watched.
    this.tickTimer = setInterval(() => {
      void this.tick().catch((error: unknown) => logger.error('the supervisor tick failed', error))
    }, TICK_INTERVAL_MS)
    this.tickTimer.unref()
  }

  views(): ServerView[] {
    return [...this.entries.values()].map(entry => this.view(entry))
  }

  /**
   * Processes this panel started that no configured entry claims any more.
   *
   * A detached child outlives a hard panel death, and the only handle is the entry-state file
   * keyed by the id it was started under. Rename the entry and no code path reads that file again;
   * remove the entry while the panel is down and `sync` reclaims it, destroying the last handle.
   * The orphan then runs with no card, no `/healthz` line and no CLI action — for a queue consumer
   * that is two consumers of one queue, which is the most damaging duplicate this tool can create.
   *
   * Read from the state directory rather than from a list, so a file left by an *earlier* panel is
   * found too. Reported, never touched: a pid here is one whose identity the platform may not be
   * able to confirm, and killing on a guess is exactly what the rest of this file refuses to do.
   */
  orphans(): ServerOrphan[] {
    return [...this.orphanCache]
  }

  /**
   * Re-reads the state directory for processes no entry owns.
   *
   * Async (it asks the platform for a birth time per pid) and therefore driven by the tick, not by
   * the state frame: the view is built on every publish, and a `readdirSync` plus an async birth
   * check there would either block or force the whole frame async.
   */
  private async refreshOrphans(): Promise<void> {
    let names: string[]
    try {
      names = fs.readdirSync(this.options.nannyDir)
    }
    catch {
      this.orphanCache = []
      return
    }

    const found: ServerOrphan[] = []
    for (const name of names) {
      if (!name.endsWith('.run.json'))
        continue
      const id = name.slice(0, -'.run.json'.length)
      // A live entry owns its own state file; that is not an orphan.
      if (this.entries.has(id))
        continue
      const state = readEntryState(path.join(this.options.nannyDir, name))
      const pid = state?.lastPid ?? null
      if (pid === null || pid === process.pid)
        continue
      const startedAt = state?.lastStartedAt ?? 0
      // The same witness `up`/`down` and the adoption guard use: a pid born *after* the record is
      // not the process we started, whoever now owns the number. Reporting it would offer a
      // one-click "Stop it" for a stranger's process, and `stopOrphan` would SIGTERM it.
      //
      // No stamp (an older state file) can only be judged by liveness, and `unknown` counts as
      // alive — the record is preserved rather than discarded on a guess.
      const liveness = startedAt > 0
        ? await processLiveness(pid, startedAt)
        : (isProcessAlive(pid) ? 'unknown' : 'gone')
      if (liveness === 'gone' || liveness === 'recycled')
        continue
      found.push({ serverId: id, pid, startedAt: startedAt > 0 ? startedAt : null })
    }
    this.orphanCache = found
  }

  /**
   * Stops one reported orphan and reclaims its record.
   *
   * Reporting without acting is a dead end: the alternative was `ps` + `kill` in a shell, which is
   * the thing this panel exists to avoid. The record is cleared only once the pid is gone — a pid
   * that survived SIGKILL keeps its file, so the next boot can still find it.
   */
  async stopOrphan(serverId: string): Promise<{ ok: boolean, error?: string }> {
    await this.refreshOrphans()
    const orphan = this.orphans().find(entry => entry.serverId === serverId)
    if (orphan === undefined)
      return { ok: false, error: `no orphaned process is running as "${serverId}"` }

    const { forced } = await terminatePids([orphan.pid], { graceMs: 5000 })
    const statePath = entryStatePath(this.options.nannyDir, serverId)
    if (isProcessAlive(orphan.pid))
      return { ok: false, error: `pid ${orphan.pid} survived the stop — kill it from a shell, its record is kept` }

    clearEntryState(statePath)
    // The record is gone, so the cached list is already wrong; refresh before publishing.
    await this.refreshOrphans()
    logger.info(`stopped the orphaned process ${orphan.pid} (was "${serverId}")${forced.length > 0 ? ', force-killed' : ''}`)
    this.publishState()
    return { ok: true }
  }

  logLines(id: string, limit?: number): LogLine[] {
    return this.entries.get(id)?.logs.list(limit) ?? []
  }

  async startAll(options: { autostartOnly?: boolean } = {}): Promise<void> {
    // Reattaching comes first and ignores `autostartOnly`: adopting a process that is
    // already running is not starting one, and leaving it unmanaged would make this
    // panel treat its own persistent entry as a stranger when a port is involved.
    for (const entry of [...this.entries.values()]) {
      if (!entry.config.persistent || this.isActive(entry))
        continue
      if (entry.config.enabled) {
        await this.resumePersistent(entry).catch((error: unknown) => {
          logger.error(`could not reattach the persistent server ${entry.config.id}`, error)
        })
        continue
      }
      // Disabled while the panel was down: someone decided this entry should not run,
      // and a nanny left over from that decision must not hide from `supervisedPids()`
      // as an unmanaged stranger. Adopting it is only the way to stop it.
      try {
        if (await this.resumePersistent(entry))
          await this.stop(entry.config.id)
      }
      catch (error) {
        logger.error(`could not stop the disabled persistent server ${entry.config.id}`, error)
      }
    }

    const targets = [...this.entries.values()]
      .filter(entry => !options.autostartOnly || entry.config.autostart)
      .map(entry => entry.config)
    // Dependencies first; levels are still started concurrently. The boot pass is the
    // only caller that starts things nobody asked for at that moment.
    for (const config of orderByDependencies(targets)) {
      await this.start(config.id, { actor: 'boot' })
    }
  }

  /**
   * Stops every entry this command owns. A persistent entry is deliberately not among
   * them: that is the whole point of the flag, and it is said out loud rather than
   * silently skipped, so "stopped everything" is never claimed about a running server.
   */
  async stopAll(): Promise<void> {
    const targets = orderByDependencies([...this.entries.values()].map(entry => entry.config)).reverse()
    for (const config of targets) {
      const entry = this.entries.get(config.id)
      if (entry !== undefined && entry.config.persistent) {
        if (this.isActive(entry))
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
    if (entry.status === 'running' || entry.status === 'starting' || entry.starting)
      return { ok: true }
    if (entry.stopping)
      return { ok: false, error: `server "${id}" is stopping` }

    // Set before the first await: two overlapping `start()` calls (a click and a
    // retry timer, say) would otherwise both reach `spawnEntry` and orphan one.
    entry.starting = true
    // Carried on the entry so every path that reaches `attachChild` records the same
    // actor; a retry is always the panel's own doing, whatever asked for the start.
    entry.actor = options.retry ? 'policy' : (options.actor ?? 'policy')
    entry.stoppedByPanel = false
    this.clearRetry(entry)
    if (!options.retry) {
      entry.restarts = 0
      // Only a start *someone asked for* ends the health sequence. The supervisor's own force
      // restart also comes through `start()` (as `policy`), and resetting there handed the budget
      // back on every attempt — the endless loop this budget exists to stop.
      if (entry.actor !== 'policy')
        entry.healthRestarts = 0
      // Same rule for the owed outcome: a restart the panel forced is announced by the panel. A
      // start someone asked for is a new sequence, so an outcome left over from a restart that a
      // manual stop cut short would credit a recovery that never happened.
      if (entry.actor !== 'policy')
        entry.pendingRestart = null
      entry.healthFailures = 0
      entry.unhealthySince = null
      // A start someone asked for ends the previous crash sequence, so the reset has
      // to reach disk too — otherwise the next panel boot resurrects the old budget.
      this.persistEntryState(entry)
    }

    try {
      await this.startDependencies(entry)
      // A stop that arrived while we were waiting must win: the process must not
      // start and then be reported as stopped.
      if (entry.stopping || this.disposed)
        return { ok: false, error: `server "${id}" is stopping` }

      entry.lastError = null
      entry.status = 'starting'
      entry.health = entry.config.health.enabled ? 'unknown' : 'disabled'
      this.publishServer(entry)

      // A persistent entry whose nanny is still alive is reattached, not restarted:
      // nothing was stopped, so there is no port to fight over and no bootstrap to
      // re-run. Only once that fails does the normal start path (and its conflict
      // policy) apply.
      if (entry.config.persistent && await this.resumePersistent(entry))
        return { ok: true }

      // The same reattach for a non-persistent entry, whose only trace of a child that
      // outlived the panel is the pid in its own state file. It is checked before the
      // bootstrap: a duplicate worker is the failure being prevented, and a bootstrap is
      // work done on the way to spawning one.
      if (!entry.config.persistent) {
        const recorded = await this.resolveRecordedChild(entry)
        if (recorded.kind === 'blocked')
          return { ok: false, error: recorded.error }
        if (recorded.kind === 'adopt')
          return this.adoptEntry(entry, recorded.pid, 'the child this panel started before it died is still running')
      }

      await this.runBootstrap(entry)
      if (entry.stopping)
        return { ok: false, error: `server "${id}" is stopping` }
      if (this.disposed)
        return { ok: false, error: 'supervisor is shutting down' }

      const conflict = await this.preflight(entry)
      if (conflict.kind === 'blocked')
        return { ok: false, error: conflict.error }
      if (conflict.kind === 'adopt')
        return this.adoptEntry(entry, conflict.pid, `a detached restart of this entry is already serving port ${entry.config.port}`)

      return this.spawnEntry(entry)
    }
    finally {
      entry.starting = false
    }
  }

  async stop(id: string): Promise<StartResult> {
    const entry = this.entries.get(id)
    if (!entry)
      return missingServer(id)
    return this.stopEntry(entry)
  }

  async restart(id: string, options: { actor?: HistoryActor } = {}): Promise<StartResult> {
    // A force restart is announced before it happens and its outcome is owed, so the internal stop
    // below must not discard it. A *user's* restart is a new sequence, and `start()` clears it.
    const owed = this.entries.get(id)?.pendingRestart ?? null
    await this.stop(id)
    const entry = this.entries.get(id)
    if (entry !== undefined && owed !== null && entry.pendingRestart === null)
      entry.pendingRestart = owed
    return this.start(id, options)
  }

  /**
   * Frees the port this entry wants, by asking whatever listens on it to leave.
   *
   * The pid is never taken from a message: holders are listed again here, and a
   * listener this panel supervises is refused rather than killed — a port held by
   * a sibling entry is a configuration mistake, not a stray process. That also
   * keeps a stale `(pid 1234)` in an old banner from killing a recycled pid.
   */
  async freePort(id: string): Promise<FreePortResult & { error?: string }> {
    const entry = this.entries.get(id)
    const empty: FreePortResult & { error?: string } = { ok: false, port: null, terminated: [], forced: [], skipped: [], free: false }
    if (!entry)
      return { ...empty, ...missingServer(id) }

    const port = entry.config.port
    if (port === null)
      return { ...empty, error: `server "${id}" has no port configured` }
    if (entry.starting || entry.stopping)
      return { ...empty, port, error: `server "${id}" is busy — try again in a moment` }

    const { ours, foreign } = await this.portHolders(port)
    const holders = [...ours, ...foreign]

    if (holders.length === 0) {
      // An empty pid list is not the same as a free port. Docker publishes through a root-owned
      // `docker-proxy`, invisible to this user's `lsof`, so a compose stack that is very much
      // running looked like nothing at all — and the advice was to retry, forever.
      const docker = await findDockerPortHolder(port)
      if (docker !== null) {
        // The socket is root's, so there is no pid to signal — but the container is stopped
        // through docker, which needs no privileges the user lacks. Freeing it is the panel's job;
        // the error below is only for docker refusing.
        this.log(entry, 'system', `freeing port ${port}: stopping the docker container "${docker.container}"`)
        const released = await releaseDockerPort(docker)
        const free = released && await this.waitForPortRelease(entry, port)
        if (free) {
          if (entry.status === 'conflict') {
            entry.status = 'stopped'
            entry.lastError = null
          }
          entry.portState = 'free'
          this.log(entry, 'system', `port ${port} is free (stopped the docker container "${docker.container}")`)
          this.publishServer(entry)
          return { ...empty, ok: true, port, terminated: [], forced: [], skipped: [], free: true }
        }
        return {
          ...empty,
          port,
          error: `docker could not stop the container "${docker.container}" publishing port ${port} — check \`docker logs ${docker.container}\``,
        }
      }
      return { ...empty, port, error: `nothing is listening on port ${port} any more` }
    }
    if (foreign.length === 0) {
      const reason = `port ${port} is held by pid ${ours.join(', ')}, which this panel supervises — stop that server instead`
      return { ...empty, port, error: reason, skipped: ours }
    }

    this.log(entry, 'system', `freeing port ${port}: asking pid ${foreign.join(', ')} to stop`)
    const { stopped, forced } = await terminatePids(foreign, { graceMs: entry.config.stop.graceMs })
    if (forced.length > 0)
      this.log(entry, 'system', `pid ${forced.join(', ')} ignored SIGTERM and was killed`)

    // A held socket can take a moment to go away, so the port decides the outcome.
    const free = await this.waitForPortRelease(entry, port)
    if (free) {
      // The reason the entry was blocked is gone, so the banner goes too.
      if (entry.status === 'conflict') {
        entry.status = 'stopped'
        entry.lastError = null
      }
      entry.portState = 'free'
      this.log(entry, 'system', `port ${port} is free${ours.length > 0 ? ` (pid ${ours.join(', ')} left untouched)` : ''}`)
      this.publishServer(entry)
    }
    else {
      entry.lastError = `port ${port} is still in use after killing pid ${foreign.join(', ')}`
      this.log(entry, 'system', entry.lastError)
      this.publishServer(entry)
    }

    return { ok: true, port, terminated: stopped, forced, skipped: ours, free }
  }

  /**
   * Splits the port's listeners into the processes this panel owns and everyone
   * else. Only the foreign half may ever be signalled — a port held by a sibling
   * is a config mistake, not a stray process. That also keeps a stale `(pid 1234)`
   * in an old banner from killing a recycled pid.
   */
  private async portHolders(port: number): Promise<{ ours: number[], foreign: number[] }> {
    const supervised = await this.supervisedPids()
    const holders = await listPortHolders(port)
    return {
      ours: holders.filter(pid => supervised.has(pid)),
      foreign: holders.filter(pid => !supervised.has(pid)),
    }
  }

  /**
   * Pids of the processes this panel owns, plus itself — the whole *tree* of every
   * entry, not just the pid it recorded.
   *
   * Both kinds of indirection are covered by that: a persistent entry runs under a
   * nanny, and a wrapper entry spawns the real server one generation down. The process
   * holding the port is a descendant in both cases, and a descendant mistaken for a
   * stranger is one `kill`/`free-port` away from stopping a server we own.
   *
   * The panel's own tree is deliberately *not* walked: "ours" has to mean a process a
   * server owns, or anything the panel happened to spawn would be unkillable and
   * unattributable.
   */
  private async supervisedPids(): Promise<Set<number>> {
    const roots: number[] = []
    for (const entry of this.entries.values()) {
      if (entry.pid !== null)
        roots.push(entry.pid)
      else if (entry.child?.pid !== undefined)
        roots.push(entry.child.pid)
    }

    const pids = await processTreePids(roots)
    pids.add(process.pid)
    return pids
  }

  /** The port's own answer, with the same short recheck the preflight uses. */
  private async waitForPortRelease(entry: Entry, port: number): Promise<boolean> {
    const freeOnAll = async (): Promise<boolean> => {
      const results = await Promise.all(this.occupancyHosts(entry).map(host => isPortFree(port, host)))
      return results.every(Boolean)
    }
    if (await freeOnAll())
      return true
    await delay(PORT_RELEASE_RECHECK_MS)
    return freeOnAll()
  }

  clearLogs(id: string): void {
    const entry = this.entries.get(id)
    if (!entry)
      return
    entry.logs.clear()
    this.publishServer(entry)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    clearInterval(this.tickTimer)
    this.storeUnsubscribe()
    for (const entry of this.entries.values()) this.clearRetry(entry)
    // Persistent entries are left running on purpose: their nannies outlive this
    // process, which is exactly what `down` is not allowed to end for them.
    await Promise.all(
      [...this.entries.values()]
        .filter(entry => !entry.config.persistent)
        .map(entry => this.stopEntry(entry)),
    )
    this.relay.dispose()
  }

  /**
   * Starts whatever this server depends on and waits for it to accept
   * connections. A dependency that refuses to come up is logged and skipped
   * rather than blocking the dependent forever.
   */
  private async startDependencies(entry: Entry): Promise<void> {
    if (entry.config.dependsOn.length === 0)
      return

    for (const dependency of dependenciesOf(entry.config, this.store.servers)) {
      const target = this.entries.get(dependency.id)
      if (!target || !dependency.enabled)
        continue

      // Start it only when it is not already on its way up — but *always* wait for it to be
      // ready. Returning early on "it already has a child" skipped the wait along with the
      // start, so on the boot and `start-all` paths (`orderByDependencies` has already spawned
      // every dependency) a dependent began 18 ms after its dependency and served before that
      // dependency had bound its port, which is the exact ordering `dependsOn` exists to stop.
      if (target.status !== 'running' && target.child === null) {
        this.log(entry, 'system', `starting dependency "${dependency.id}" first`)
        await this.start(dependency.id)
      }

      const deadline = Date.now() + dependency.health.startTimeoutMs
      const isReady = (): boolean => {
        const status = this.statusOf(target)
        if (status !== 'running')
          return false
        // "Healthy" specifically, not "not unhealthy": in http mode the entry is `unknown` from
        // the moment it accepts a connection until the first probe answers, and starting a
        // dependent in that window is starting it against a dependency nobody has checked.
        // `disabled` means the entry declares no health check, so its `running` is all there is.
        return target.health === 'healthy' || target.health === 'disabled'
      }

      while (!isReady() && Date.now() < deadline) await delay(250)

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

  /**
   * Summaries are rebuilt when history changes or every few seconds, because
   * `view()` runs on every state frame and the window math is O(events).
   */
  private summarizeHistory(entry: Entry): ServerView['history'] {
    const now = Date.now()
    const revision = this.options.history.revision
    const cached = entry.historyCache
    if (cached !== null && cached.revision === revision && now - cached.at < HISTORY_CACHE_MS)
      return cached.summary

    const runningSince = entry.child !== null && entry.startedAt !== null ? entry.startedAt : null
    const summary = this.options.history.summarize(entry.config.id, HISTORY_WINDOW_MS, now, runningSince)
    entry.historyCache = { revision, at: now, summary }
    return summary
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
    this.clearRetry(entry)
    entry.nextRetryAt = null

    // Set first: a start that is still bootstrapping (no child yet) checks this
    // after every await and aborts, instead of spawning behind our back.
    entry.stopping = true

    // A persistent entry whose nanny is running but which this panel never attached to
    // — `--no-autostart` skips the reattach pass, and a hand edit can add one after boot
    // — has no child and no pid, so the early return below would answer "stopped" while
    // the nanny and the real server kept running. Adopt it first so the stop has a
    // handle to reach, which is what `startAll()` does for a disabled entry.
    if (entry.config.persistent && entry.child === null && entry.pid === null) {
      await this.resumePersistent(entry).catch((error: unknown) => {
        logger.error(`could not reattach the persistent server ${entry.config.id} to stop it`, error)
      })
    }

    if (entry.child === null && entry.pid === null) {
      entry.stopping = false
      entry.status = 'stopped'
      this.publishServer(entry)
      return { ok: true }
    }

    // Stopping one server does **not** cascade: `stopAll` walks `orderByDependencies(...).reverse()`, so
    // dependents stop first, but a single stop is a narrow act and the panel does not decide to kill
    // something the person did not name. What it must not do is stay silent — the dependent is now
    // running against a dependency that is gone, and nothing else would say so.
    const orphaned = dependentsOf(entry.config, this.store.servers)
      .filter((dependent) => {
        const state = this.entries.get(dependent.id)
        return state !== undefined && this.isActive(state)
      })
    if (orphaned.length > 0)
      this.log(entry, 'system', `still running and depending on this: ${orphaned.map(dependent => dependent.id).join(', ')}`)

    entry.status = 'stopping'
    this.publishServer(entry)

    // A persistent entry's nanny is only the handle; the server is the child it owns.
    // A stop this process cannot forward — `SIGKILL` cannot be trapped, and
    // `stop.killGroup: false` signals the pid alone — would leave that child running
    // while the panel reported "stopped". Its pid is in the state file.
    const nannyState = entry.config.persistent
      ? readNannyState(nannyStatePath(this.options.nannyDir, entry.config.id))
      : null

    // An adopted successor is not our child: same shutdown, signalled by pid.
    const outcome = entry.child === null && entry.pid !== null
      ? await terminatePid(entry.pid, entry.config.stop)
      : await terminate(entry.child!, entry.config.stop)
    if (outcome === 'force-killed')
      this.log(entry, 'system', 'force-killed after grace period')

    if (nannyState?.childPid != null && !entry.config.stop.killGroup)
      await terminatePid(nannyState.childPid, { ...entry.config.stop, killGroup: false })

    const { port, stop } = entry.config
    if (stop.killPortHolders && port !== null) {
      // Only a stranger: a port held by a server this panel supervises is a config
      // mistake, not a leftover, and is never killed from here.
      const leftover = await killPortHolders(port, await this.supervisedPids())
      if (leftover.length > 0)
        this.log(entry, 'system', `port ${port} was still held by pid ${leftover.join(', ')} — killed`)
    }

    // An explicit stop ends a persistent entry for real: nothing may reattach to it,
    // and nothing should keep tailing a log no nanny writes any more. A pid that
    // outlived SIGKILL is the exception — its state file is the only way a later boot
    // can find it, so it is kept and the outcome is not dressed up as "stopped".
    const survivor = entry.config.persistent && entry.pid !== null && isProcessAlive(entry.pid)
      ? entry.pid
      : null
    if (entry.config.persistent) {
      if (survivor === null) {
        clearNannyState(nannyStatePath(this.options.nannyDir, entry.config.id))
        clearNannySpec(nannySpecPath(this.options.nannyDir, entry.config.id))
      }
      else {
        this.log(entry, 'system', `pid ${survivor} is still alive after the stop — its state file is kept`)
      }
      // A stop is the last chance to read what the nanny wrote on its way out.
      this.drainRelay(entry)
    }

    entry.stopping = false
    entry.child = null
    entry.pid = null
    entry.adopted = false
    entry.nannyExit = null
    // A recorded child that is gone must not be chased by a later boot; one that outlived
    // the stop is kept, so the next start still refuses to duplicate it.
    if (entry.lastChild !== null && !isProcessAlive(entry.lastChild.pid)) {
      entry.lastChild = null
      this.persistEntryState(entry)
    }
    entry.status = survivor === null ? 'stopped' : 'conflict'
    if (survivor !== null)
      entry.lastError = `pid ${survivor} survived the stop`
    this.log(entry, 'system', survivor === null ? 'stopped' : entry.lastError!)
    this.publishServer(entry)
    return survivor === null
      ? { ok: true }
      : { ok: false, error: entry.lastError! }
  }

  private createEntry(config: ServerConfig): Entry {
    // The retry budget, the bootstrap flag and the last child are read back from disk:
    // all three are decisions that have to outlive this panel, and in memory alone a
    // crash loop got a fresh `maxRetries` from every panel start and a detached child
    // that outlived a hard kill became invisible — so the next boot spawned a twin.
    const persisted = readEntryState(entryStatePath(this.options.nannyDir, config.id))
    const lastPid = persisted?.lastPid ?? null
    return {
      config,
      status: 'stopped',
      health: config.health.enabled ? 'unknown' : 'disabled',
      portState: 'unknown',
      child: null,
      pid: null,
      startedAt: null,
      lastChild: !config.persistent && lastPid !== null ? { pid: lastPid, startedAt: persisted?.lastStartedAt ?? 0 } : null,
      exitCode: null,
      exitSignal: null,
      restarts: persisted?.restarts ?? 0,
      healthRestarts: persisted?.healthRestarts ?? 0,
      lastError: null,
      nextRetryAt: null,
      retryTimer: null,
      healthFailures: 0,
      unhealthySince: null,
      pendingRestart: null,
      lastProbeAt: 0,
      lastOccupancyProbeAt: 0,
      probing: false,
      adopted: false,
      stoppedByPanel: false,
      nannyExit: null,
      starting: false,
      stopping: false,
      actor: 'policy',
      removed: false,
      bootstrapDone: persisted?.bootstrapDone ?? !config.bootstrap,
      logs: new LogBuffer(config.logBufferLines),
      echoed: new Set(),
      responseMs: null,
      resources: null,
      resourcesSampledAt: 0,
      historyCache: null,
    }
  }

  private sync(): void {
    const wanted = new Map(this.store.servers.map(server => [server.id, server]))

    for (const [id, entry] of [...this.entries]) {
      const config = wanted.get(id)
      if (!config) {
        this.entries.delete(id)
        this.relay.unfollow(id)
        // The entry is gone, so its log files are history nothing will ever serve — and leaving them
        // was not harmless: re-adding an id (a rename-back, a config edit, a restore) made `readTail`
        // return the *previous* server's lines as if they were the new one's. Only the explicit
        // `DELETE /api/logs/:id` used to clear them, and a removed server never hits that route.
        // Safe here because a config that fails to parse keeps the last trusted server list, so a
        // transient bad edit does not read as "every server was removed".
        this.options.logFiles.clear(id)
        // The same reclaim for history: without it a re-added id inherits the old entry's crash time
        // and events, and the card reports "Last crash" for a server that was never started.
        this.options.history.forget(id)
        // And for the persisted budget: a re-added id would otherwise inherit a spent
        // retry count and give up on its very first crash.
        clearEntryState(entryStatePath(this.options.nannyDir, id))
        // Flagged so the stop below cannot write either back: `stopEntry` logs its own last lines
        // ("stopped", "force-killed after grace period") through `this.log`, which would recreate
        // both artifacts for an id that no longer exists. Clearing *after* the stop would race a
        // re-add of the same id instead, wiping the new entry's log.
        entry.removed = true
        void this.stopEntry(entry).catch((error: unknown) => {
          logger.error(`could not stop the removed server ${id}`, error)
        })
        continue
      }
      const bufferChanged = entry.config.logBufferLines !== config.logBufferLines
      // The flag decides how the entry is *run*, so it takes effect on the next start;
      // what must not linger is a tailer for an entry that is no longer persistent —
      // and whatever it had not read yet still belongs to this entry.
      if (entry.config.persistent && !config.persistent)
        this.drainRelay(entry)
      entry.config = config
      if (bufferChanged) {
        const kept = entry.logs.list(config.logBufferLines)
        entry.logs = new LogBuffer(config.logBufferLines)
        entry.logs.extend(kept)
      }
      if (!config.enabled && this.isActive(entry)) {
        void this.stopEntry(entry).catch((error: unknown) => {
          logger.error(`could not stop the disabled server ${id}`, error)
        })
      }
    }

    for (const [id, config] of wanted) {
      if (!this.entries.has(id))
        this.entries.set(id, this.createEntry(config))
    }

    this.publishState()
  }

  private isActive(entry: Entry): boolean {
    // An adopted successor has no child of ours but is very much running, so it has to
    // count here — otherwise disabling the entry would leave it serving.
    return entry.child !== null || entry.pid !== null || entry.adopted || entry.status === 'backoff'
  }

  /** Loopback first, then the configured address, so a custom bind is still probed. */
  private probeHosts(entry: Entry): string[] {
    const primary = '127.0.0.1'
    const configured = displayHost(entry.config.bind)
    return configured === primary ? [primary] : [primary, configured]
  }

  /**
   * Where a port can actually be observed for this entry. A server bound to a
   * specific address is not reachable on loopback, and a `lan` bind is reachable
   * there *and* on this machine's LAN address.
   */
  private occupancyHosts(entry: Entry): string[] {
    const configured = bindHost(entry.config.bind)
    const candidates = configured === '0.0.0.0'
      ? ['127.0.0.1', lanAddress() ?? '127.0.0.1']
      : [configured, '127.0.0.1']
    return [...new Set(candidates)]
  }

  /** True when the port accepts a connection on any of the entry's addresses. */
  private async portAccepts(entry: Entry, port: number, timeoutMs: number): Promise<boolean> {
    const results = await Promise.all(this.occupancyHosts(entry).map(host => probePort(host, port, timeoutMs)))
    return results.some(Boolean)
  }

  /**
   * The port holder that is this entry's own detached successor — a program that
   * restarted itself leaves a process behind, and that process is the *same server*,
   * not a stranger to kill.
   *
   * The environment marker is authoritative where the platform can read it (Linux,
   * macOS). Failing that — Windows has no per-process environment at all — the entry's
   * own argv answers, which a successor keeps unless it re-execs under a different
   * image. Ambiguity is not resolved by guessing: two holders that both look like this
   * entry means we do not know which one is ours, so we act on neither.
   */
  private async ownPortHolder(entry: Entry, holders: number[]): Promise<number | null> {
    const spawn = this.resolveSpawn(entry)
    const candidates = await identifyHolders(entry.config.id, spawn, holders)

    if (candidates.length > 1) {
      this.log(entry, 'system', `pid ${candidates.join(', ')} all look like this entry: refusing to guess which is ours, set onPortConflict to "kill" to clear the port anyway`)
      return null
    }

    return candidates[0] ?? null
  }

  private async preflight(entry: Entry): Promise<PreflightConflict> {
    const port = entry.config.port
    if (port === null)
      return { kind: 'free' }

    // A listener that was just closed can still complete a handshake for a few
    // milliseconds, which is exactly the window a fast restart lands in — so a
    // busy-looking port gets a second look before it is treated as a conflict.
    // The configured address first: a server bound to a LAN ip is not "free" just
    // because nothing holds it on loopback.
    const hosts = this.occupancyHosts(entry)
    const freeOnAll = async (): Promise<boolean> => {
      const results = await Promise.all(hosts.map(host => isPortFree(port, host)))
      return results.every(Boolean)
    }

    let free = await freeOnAll()
    if (!free) {
      await delay(PORT_RELEASE_RECHECK_MS)
      free = await freeOnAll()
    }

    entry.portState = free ? 'free' : 'in-use'
    if (free)
      return { kind: 'free' }

    // One split serves every policy: the supervised half is never a target, and the
    // foreign half is where our own detached successor hides.
    const { ours, foreign } = await this.portHolders(port)
    const holders = [...ours, ...foreign]
    const own = await this.ownPortHolder(entry, foreign)
    // An empty pid list is not nothing: a docker-published port is bound by a root-owned proxy
    // this user cannot see, so name the container instead of reporting no holder at all.
    const docker = holders.length === 0 ? await findDockerPortHolder(port) : null
    const suffix = holders.length > 0
      ? ` (pid ${holders.join(', ')})`
      : docker === null ? '' : ` (published by the docker container "${docker.container}")`

    // `kill` asks for the port outright: whoever holds it goes, this entry's own
    // successor included. It never touches our own process tree — a port held by
    // the panel or a sibling stays a config mistake, exactly as `follow`/`reclaim`.
    if (entry.config.onPortConflict === 'kill') {
      if (ours.length > 0) {
        entry.status = 'conflict'
        entry.lastError = `port ${port} is held by pid ${ours.join(', ')}, which this panel supervises — stop that server instead`
        this.log(entry, 'system', `${entry.lastError} — not starting (onPortConflict: kill)`)
        this.publishServer(entry)
        return { kind: 'blocked', error: entry.lastError }
      }

      if (foreign.length === 0) {
        if (docker !== null) {
          // `kill` means "I want this port". Docker's socket is root's, so there is no pid to
          // signal — but the container is stoppable through docker, which is the same intent.
          this.log(entry, 'system', `port ${port} is published by the docker container "${docker.container}" — onPortConflict: kill, stopping it`)
          if (await releaseDockerPort(docker) && await this.waitForPortRelease(entry, port))
            return { kind: 'free' }
          entry.status = 'conflict'
          entry.lastError = `docker could not stop the container "${docker.container}" publishing port ${port}`
          this.publishServer(entry)
          return { kind: 'blocked', error: entry.lastError }
        }
        // The probe says busy but no listener could be listed: let the start decide.
        this.log(entry, 'system', `port ${port} looks busy but no listener could be found — starting anyway`)
        return { kind: 'free' }
      }

      this.log(entry, 'system', `port ${port} is held by pid ${foreign.join(', ')} — onPortConflict: kill, stopping the holder`)
      return await this.stopPortHolders(entry, foreign, port, 'killing', freeOnAll)
    }

    // A detached restart of this same server. Following it keeps whatever the program
    // set up (at the cost of its output, which belongs to whoever spawned it);
    // reclaiming the port buys back a fully supervised process instead.
    if (own !== null && entry.config.onPortConflict === 'follow')
      return { kind: 'adopt', pid: own }

    if (own !== null && entry.config.onPortConflict === 'reclaim') {
      this.log(entry, 'system', `port ${port} is held by pid ${own}, a detached restart of this entry — replacing it with a supervised process`)
      return await this.stopPortHolders(entry, [own], port, 'replacing', freeOnAll)
    }

    const hint = own !== null
      ? ` — pid ${own} is a detached restart of this entry: set onPortConflict to "follow" to adopt it, "reclaim" to replace it with a supervised process, or "kill" to stop whatever holds the port`
      : docker === null
        ? ''
        : ` — it is published by a docker container, which \`kill\` stops through docker; \`block\` and \`warn\` leave it alone`

    // `follow` and `reclaim` refine `block`: never a stranger's port.
    if (entry.config.onPortConflict !== 'warn') {
      entry.status = 'conflict'
      entry.lastError = `port ${port} is already in use${suffix}${hint}`
      this.log(entry, 'system', `${entry.lastError} — not starting (onPortConflict: ${entry.config.onPortConflict})`)
      this.publishServer(entry)
      return { kind: 'blocked', error: entry.lastError }
    }

    this.log(entry, 'system', `warning: port ${port} is already in use${suffix}${hint} — starting anyway`)
    return { kind: 'free' }
  }

  /**
   * Stops the listed port holders and reports whether the port came free.
   *
   * `kill` and `reclaim` are the same sequence over a different pid list — the foreign
   * holder versus this entry's own detached successor — and they have to stay the same:
   * a stop that does not re-probe, or that reports the port free without waiting, spawns
   * onto a listener that is still there.
   */
  private async stopPortHolders(entry: Entry, pids: number[], port: number, word: string, freeOnAll: () => Promise<boolean>): Promise<PreflightConflict> {
    const { forced } = await terminatePids(pids, { graceMs: entry.config.stop.graceMs })
    if (forced.length > 0)
      this.log(entry, 'system', `pid ${forced.join(', ')} ignored SIGTERM and was killed`)

    await delay(PORT_RELEASE_RECHECK_MS)
    if (await freeOnAll()) {
      entry.portState = 'free'
      return { kind: 'free' }
    }
    entry.status = 'conflict'
    entry.lastError = `port ${port} is still in use after ${word} pid ${pids.join(', ')}`
    this.log(entry, 'system', entry.lastError)
    this.publishServer(entry)
    return { kind: 'blocked', error: entry.lastError }
  }

  /**
   * Takes over a detached successor: no spawn, no duplicate. The pid is supervised
   * from here on (liveness, health probe, resources, stop), while its output stays
   * wherever it was redirected.
   *
   * For a persistent entry that output is not a mystery: its nanny is still writing
   * the entry's log file, so the relay is started here too. Without this, adopting a
   * persistent entry whose state file was lost would show its history but never
   * another live line.
   *
   * `reason` is the caller's sentence for *why* this pid is ours: a port holder and a
   * recorded child that survived a hard panel death are the same adoption, said
   * differently, and the log line is the only place a person sees which happened.
   */
  private adoptEntry(entry: Entry, pid: number, reason: string): StartResult {
    entry.adopted = true
    entry.pid = pid
    entry.child = null
    entry.status = 'running'
    entry.health = entry.config.health.enabled ? 'unknown' : 'disabled'
    entry.startedAt = Date.now()
    entry.lastError = null
    // The history comes first, and logging last, so the buffer stays in order: an
    // attach fills an empty buffer, so its own line has to be written after it.
    if (entry.config.persistent)
      this.followPersistent(entry, true)
    this.log(entry, 'system', `adopted pid ${pid}: ${reason}`)
    this.publishServer(entry)
    return { ok: true }
  }

  /**
   * The child this entry's state file recorded, when it is still that same process.
   *
   * A non-persistent child is spawned detached, so it survives a panel killed hard while
   * nothing else remembers it — `preflight` cannot help a portless entry, which is how a
   * portless worker got a second copy beside the running one. A pid is recycled, so
   * liveness alone proves nothing: the birth time and the marker decide, and a pid this
   * platform cannot place is never adopted on a guess.
   *
   * The record is cleared only once its process is known to be gone or to be somebody
   * else, so a stale pid is never chased and a live one is never forgotten into a twin.
   */
  private async resolveRecordedChild(entry: Entry): Promise<RecordedChild> {
    const recorded = entry.lastChild
    if (recorded === null)
      return { kind: 'none' }

    // Our own pid is nonsense the file could carry: never adopt the panel itself.
    if (recorded.pid === process.pid) {
      entry.lastChild = null
      this.persistEntryState(entry)
      return { kind: 'none' }
    }

    // `recycled` is the same witness `up`/`down` use: the pid is live but was born *after*
    // this panel recorded it, so it is not the child we spawned whoever else it now is.
    // An older file carries a pid with no stamp, and a stamp of 0 would read as recycled
    // for a live process, so liveness alone is all that record can be judged by.
    const liveness = recorded.startedAt > 0
      ? await processLiveness(recorded.pid, recorded.startedAt)
      : (isProcessAlive(recorded.pid) ? 'unknown' : 'gone')
    if (liveness === 'gone' || liveness === 'recycled') {
      entry.lastChild = null
      this.persistEntryState(entry)
      return { kind: 'none' }
    }

    if (await processCarriesServerId(recorded.pid, entry.config.id))
      return { kind: 'adopt', pid: recorded.pid }

    // Alive and this platform cannot say whose it is — Windows exposes no per-process
    // environment at all. With a port, the listener and the entry's own `onPortConflict`
    // stay the witnesses, so the ordinary preflight runs; without one there is nothing
    // else to ask, and refusing beats duplicating: a second portless worker (a bot, a
    // queue consumer) is the dangerous kind of duplicate.
    if (entry.config.port !== null)
      return { kind: 'none' }

    const error = `pid ${recorded.pid} may be a child this panel started for "${entry.config.id}" before it died, and this platform cannot confirm whose it is — not starting a second copy, stop pid ${recorded.pid} to clear it`
    entry.status = 'conflict'
    entry.lastError = error
    this.log(entry, 'system', error)
    this.publishServer(entry)
    return { kind: 'blocked', error }
  }

  /** Clears the durable record of the last child, once that pid is known to be gone. */
  private forgetRecordedChild(entry: Entry, pid: number | null): void {
    if (pid === null || entry.lastChild === null || entry.lastChild.pid !== pid)
      return
    entry.lastChild = null
    this.persistEntryState(entry)
  }

  /** An adopted successor disappeared: fall back to the normal lifecycle. */
  private handleAdoptedExit(entry: Entry): void {
    const adoptedPid = entry.pid
    if (entry.pid !== null)
      this.sampler.forget(entry.pid)
    // A nanny that vanished while we watched still leaves the real exit behind.
    if (entry.config.persistent)
      this.consumeNannyExit(entry)
    const ranForMs = entry.nannyExit?.runtimeMs ?? (entry.startedAt === null ? 0 : Date.now() - entry.startedAt)
    const detail = entry.nannyExit === null ? 'adopted process exited' : describeNannyExit(entry.nannyExit)
    entry.nannyExit = null
    entry.adopted = false
    entry.pid = null
    // Known gone, so the durable record goes with it: a pid kept past its process is a
    // later boot adopting whatever unrelated process inherited the number.
    this.forgetRecordedChild(entry, adoptedPid)
    entry.resources = null
    entry.responseMs = null
    // The same reset as a child we spawned: health is about a process, and this one is gone.
    entry.health = entry.config.health.enabled ? 'unknown' : 'disabled'
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

  private async runBootstrap(entry: Entry): Promise<void> {
    const spec = entry.config.bootstrap
    if (!spec || (spec.runOnce && entry.bootstrapDone))
      return

    const vars = this.buildVars(entry)
    const cwd = resolveCwd(entry.config.cwd)
    const args = resolveTemplates(spec.args, vars)
    this.log(entry, 'system', `bootstrap: ${spec.command} ${args.join(' ')}`)

    const splitter = new LineSplitter((_stream, text) => {
      if (text.trim().length > 0)
        this.log(entry, 'system', `[bootstrap] ${text}`)
    })

    // `spawn` throws synchronously for a command it cannot use at all — an empty
    // string, a NUL byte, a cwd reached through a regular file. Letting that escape
    // would reject `start()` after it already set `status = 'starting'`, leaving the
    // entry wedged in `starting` with no pid until the daemon restarts. A bootstrap
    // is best-effort anyway: report it and let the entry start.
    let child: ChildProcess
    try {
      child = spawn(resolveCommand(spec.command, cwd, projectDir), args, {
        cwd,
        env: { ...process.env, ...resolveRecord(spec.env, vars) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    }
    catch (error) {
      this.log(entry, 'system', `bootstrap could not start: ${(error as Error).message} — continuing anyway`)
      entry.bootstrapDone = true
      this.persistEntryState(entry)
      return
    }
    child.stdout?.on('data', chunk => splitter.push('stdout', chunk))
    child.stderr?.on('data', chunk => splitter.push('stderr', chunk))

    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        this.log(entry, 'system', `bootstrap timed out after ${spec.timeoutMs}ms`)
        try {
          child.kill('SIGKILL')
        }
        catch {
          // already gone
        }
      }, spec.timeoutMs)
      child.once('exit', (exitCode) => {
        clearTimeout(timer)
        resolve(exitCode)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        this.log(entry, 'system', `bootstrap failed: ${(error as Error).message}`)
        resolve(null)
      })
    })

    entry.bootstrapDone = true
    this.persistEntryState(entry)
    if (code === 0)
      this.log(entry, 'system', 'bootstrap finished')
    else if (code !== null)
      this.log(entry, 'system', `bootstrap exited with code ${code} — continuing anyway`)
  }

  /**
   * Everything `spawn` needs for an entry: the resolved image, the expanded argv, the
   * cwd and the environment. The argv is also what the preflight recognizes the entry's
   * own detached successor by, so spawn and identification must never resolve it twice
   * with two different rules.
   */
  private resolveSpawn(entry: Entry): SpawnInfo & { env: Record<string, string>, loggedArgs: string[] } {
    const vars = this.buildVars(entry)
    const cwd = resolveCwd(entry.config.cwd)
    const command = resolveCommand(entry.config.command, cwd, projectDir)

    // A machine-local env file is layered over the tracked config and also feeds
    // `${VAR}` in args/env, so secrets stay out of servers.config.json.
    let fileEnv: Record<string, string> = {}
    if (entry.config.envFile.length > 0) {
      const file = resolveEnvFilePath(entry.config.envFile, cwd)
      const loaded = loadEnvFile(file)
      if (loaded.error !== null)
        this.log(entry, 'system', `env file ${file} could not be read: ${loaded.error}`)
      else if (Object.keys(loaded.env).length > 0)
        this.log(entry, 'system', `env file ${file} (${Object.keys(loaded.env).length} vars)`)
      fileEnv = loaded.env
    }

    const expansionVars: Record<string, string | undefined> = { ...process.env, ...fileEnv }
    // A data env's value is a directory this entry owns, so it is normalized to one
    // absolute native path: a config writes `{projectDir}/data`, and a Windows run would
    // otherwise hand the process a mixed `D:\…\app/data` that Backups has to re-resolve.
    const dataEnvs = resolveRecord(entry.config.dataEnvs, vars)
    const env: Record<string, string> = {
      // `envFile` is the machine-local layer, so it overrides the tracked `env`.
      ...expandEnvRecord(resolveRecord(entry.config.env, vars), expansionVars),
      ...fileEnv,
      // Data envs win over `env`: their value is the directory that gets backed
      // up, so the process has to be pointed at exactly that path.
      ...expandEnvRecord(dataEnvs, expansionVars),
      HHOSTED_SERVER_ID: entry.config.id,
      HHOSTED_CONTROL_PORT: String(this.options.control.port),
    }
    for (const key of Object.keys(dataEnvs))
      env[key] = path.resolve(cwd, env[key]!)

    // `spawn` **throws** on an env key containing a NUL, so the entry failed to start with Node's raw
    // message naming an invisible character: `The property 'options.env[…]' must be a string without
    // null bytes`. A NUL reaches here from either side — an `envFile` line (the parser takes the text
    // before the first `=`, whatever it is) or a JSON config (`\u0000` is a legal escape). Dropped
    // rather than fatal, so one bad key does not stop the other thirty from loading.
    for (const key of Object.keys(env)) {
      if (!key.includes('\0'))
        continue
      delete env[key]
      this.log(entry, 'system', 'ignored an environment key containing a null byte')
    }

    return {
      command,
      args: expandEnvList(resolveTemplates(entry.config.args, vars), expansionVars),
      env,
      cwd,
      // Logged *before* `${VAR}` expansion: an argument like `${API_TOKEN}` must not
      // land in the ring buffer, the rotated files, SSE or Telegram.
      loggedArgs: resolveTemplates(entry.config.args, vars),
    }
  }

  private spawnEntry(entry: Entry): StartResult {
    // A persistent entry is not run by this process: it gets a nanny, whose whole
    // purpose is to keep the pipes alive when the panel is gone.
    return entry.config.persistent ? this.spawnNanny(entry) : this.spawnDirect(entry)
  }

  private spawnDirect(entry: Entry): StartResult {
    const { command, args, env, cwd, loggedArgs } = this.resolveSpawn(entry)

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

    this.attachChild(entry, child, `${command} ${args.join(' ')}`.trim(), () => {
      stdout.flush('stdout')
      stderr.flush('stderr')
    })
    return { ok: true }
  }

  /**
   * Starts a persistent entry: the panel spawns a *nanny*, which spawns the entry and
   * owns its pipes. From here the nanny is the child this supervisor tracks — its exit
   * event drives the normal lifecycle (backoff, history, notifications) — while the
   * real exit cause is read back from the state file the nanny leaves behind.
   */
  private spawnNanny(entry: Entry): StartResult {
    const { command, args, env, cwd, loggedArgs } = this.resolveSpawn(entry)

    this.log(entry, 'system', `start (persistent): ${command} ${loggedArgs.join(' ')}`)

    // The panel itself was launched through this entry point, so this is the CLI to
    // re-run — under tsx, from dist/cli.js and through the published bin alike.
    const entryPoint = nannyEntryPoint()
    if (entryPoint.length === 0)
      return this.failSpawn(entry, 'cannot locate this CLI to start a persistent entry')

    const id = entry.config.id
    const specPath = nannySpecPath(this.options.nannyDir, id)
    const statePath = nannyStatePath(this.options.nannyDir, id)
    // The spec carries the already-expanded argv and env: `resolveSpawn()` stays the
    // only resolver, and the nanny never re-expands anything. It is 0600 and the nanny
    // unlinks it as it reads it, because expanded env may hold secrets.
    const spec: NannySpec = {
      serverId: id,
      command,
      args,
      cwd,
      env,
      logDir: this.options.logFiles.directory,
      logs: this.options.logFiles.config,
      stop: entry.config.stop,
    }

    let child: ChildProcess
    try {
      writeNannySpec(specPath, spec)
      child = spawn(process.execPath, nannyArgv(entryPoint, id, specPath, statePath), {
        cwd,
        env: { ...process.env, ...env, HHOSTED_HOME: dataRoot, HHOSTED_PROJECT: projectDir },
        // The nanny reports through the entry's log file, so it holds no pipe of ours:
        // nothing the panel does (or fails to do) can break its output.
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
        windowsHide: true,
      })
    }
    catch (error) {
      clearNannySpec(specPath)
      return this.failSpawn(entry, (error as Error).message)
    }

    // Outliving this panel is the point, so the loop must not be held open by it.
    child.unref()

    this.attachChild(entry, child, `nanny → ${command} ${args.join(' ')}`.trim())
    this.followPersistent(entry)
    return { ok: true }
  }

  private failSpawn(entry: Entry, message: string): StartResult {
    entry.status = 'crashed'
    entry.lastError = message
    this.log(entry, 'system', `spawn failed: ${message}`)
    this.publishServer(entry)
    return { ok: false, error: message }
  }

  /** The bookkeeping every spawn shares, plus the exit events that end it. */
  private attachChild(entry: Entry, child: ChildProcess, detail: string, flush?: () => void): void {
    entry.child = child
    entry.pid = child.pid ?? null
    entry.startedAt = Date.now()
    // The durable record of a child that can outlive this panel. A persistent entry's
    // child here is its *nanny*, which already writes its own state file with the pid a
    // later boot reattaches through — a second record could only be a second truth, so
    // it is deliberately not written for one.
    if (!entry.config.persistent && child.pid !== undefined) {
      entry.lastChild = { pid: child.pid, startedAt: entry.startedAt }
      this.persistEntryState(entry)
    }
    this.options.history.record(entry.config.id, { type: 'start', detail, actor: entry.actor })
    entry.exitCode = null
    entry.exitSignal = null
    entry.nannyExit = null
    entry.lastProbeAt = 0
    entry.healthFailures = 0
    entry.unhealthySince = null
    this.publishServer(entry)

    child.once('error', (error) => {
      // `spawn java -jar x ENOENT` is raw errno text, and the UI printed it verbatim with no way
      // to learn what it meant. Naming the program and what to check is the whole difference
      // between "the product is broken" and "Java is not installed".
      entry.lastError = describeSpawnError(error as NodeJS.ErrnoException, entry.config.command)
      this.log(entry, 'system', `process error: ${entry.lastError}`)
      flush?.()
      this.handleExit(entry, child, null, null)
    })

    child.once('exit', (code, signal) => {
      flush?.()
      this.handleExit(entry, child, code, signal)
    })

    void this.awaitReadiness(entry, child)
  }

  /**
   * Live output for a persistent entry, which arrives by reading its log file rather
   * than down a pipe. It is pushed into the same ring buffer and published as the same
   * SSE frame a normal entry's output is, so nothing downstream knows the difference.
   */
  private ingestExternalLines(serverId: string, lines: LogLine[]): void {
    const entry = this.entries.get(serverId)
    if (entry === undefined || !entry.config.persistent || lines.length === 0)
      return

    // This panel's own lines live in that file too: an echo is not news.
    const kept = lines.filter(line => !forgetEchoedLine(entry.echoed, line))
    if (kept.length === 0)
      return

    for (const line of kept) entry.logs.push(line)
    // One frame per batch: this is a file tail, and a burst of lines would otherwise
    // become a burst of frames.
    this.hub.publish({ type: 'log', ts: kept[kept.length - 1]!.ts, workspaceId: this.options.workspaceId, serverId, lines: kept })
  }

  /**
   * Whatever the relay had not read yet, ingested before its tailer goes: a nanny's
   * exit and a stop both end with lines the panel has never seen.
   */
  private drainRelay(entry: Entry): void {
    const rest = this.relay.unfollow(entry.config.id)
    if (rest.length > 0)
      this.ingestExternalLines(entry.config.id, rest)
  }

  /**
   * Follows a persistent entry's log file, filling the ring buffer from what is on disk.
   *
   * The backfill is read *through* the tailer, which is the only thing that may own the
   * offset: reading it from `LogFiles` first and seeking to EOF second would either
   * replay a line as news or skip one as history, depending on which order the two
   * syscalls happen to land in.
   *
   * `attach` is the caller's word for "this entry is already running, and its history is
   * new to this panel": only then is the file's tail history. The buffer itself cannot
   * answer that — spawn, adopt and reattach all log a line of their own — which is why a
   * `logs.size === 0` test left this backfill dead. An empty buffer is still required, so
   * a second attach to an entry we already hold lines for cannot replay older ones on top.
   */
  private followPersistent(entry: Entry, attach = false): void {
    const id = entry.config.id
    // `logs.persist: false` means that history is not served, and the backfill follows suit.
    const backfill = attach && entry.logs.size === 0 && this.options.logFiles.config.persist
      ? PERSISTENT_BACKFILL_LINES
      : 0

    const history = this.relay.follow(id, nannyLogFile(this.options.logFiles.directory, id), { backfill })
    if (history.length > 0)
      entry.logs.extend(history)
  }

  /**
   * Reattaches to a persistent entry that is still running, or reports how it ended
   * while nobody was watching. Never starts anything: that is `start()`'s job, and it
   * is what keeps this honest about "not starting entries on your own".
   */
  private async resumePersistent(entry: Entry): Promise<boolean> {
    const id = entry.config.id
    const state = readNannyState(nannyStatePath(this.options.nannyDir, id))

    if (state !== null && state.serverId === id && await nannyIsAlive(state, id)) {
      entry.adopted = true
      entry.child = null
      entry.pid = state.nannyPid
      entry.startedAt = state.startedAt
      entry.status = 'running'
      entry.health = entry.config.health.enabled ? 'unknown' : 'disabled'
      entry.portState = entry.config.port === null ? 'unknown' : 'in-use'
      entry.lastError = null
      entry.nannyExit = null
      const child = state.childPid === null ? '' : `, server pid ${state.childPid}`
      this.followPersistent(entry, true)
      this.log(entry, 'system', `persistent: still running (nanny pid ${state.nannyPid}${child}) — reattached`)
      this.publishServer(entry)
      return true
    }

    if (state === null)
      return false

    // The nanny is gone. Its state file is the only witness of what happened, so it is
    // read, reported and consumed exactly once.
    this.consumeNannyExit(entry)
    const exit = entry.nannyExit
    entry.nannyExit = null
    if (exit === null)
      return false

    const detail = exit.code === null && exit.signal === null ? 'it could not start' : describeNannyExit(exit)
    const ranFor = `${Math.max(1, Math.round(exit.runtimeMs / 1000))}s`
    this.options.history.record(id, { type: 'exit', detail: `while the panel was away: ${detail}`, runtimeMs: exit.runtimeMs })
    this.log(entry, 'system', `persistent: exited while the panel was away with ${detail} after ${ranFor}`)

    if (exit.code !== 0 || exit.signal !== null) {
      entry.status = 'crashed'
      entry.lastError = `exited while the panel was away with ${detail}`
      this.options.history.record(id, { type: 'crash', detail: entry.lastError, runtimeMs: exit.runtimeMs })
      this.notify(entry, 'crash', entry.lastError)
    }
    this.publishServer(entry)
    return false
  }

  /**
   * The nanny's last word, then the state file goes: a panel that has read how the
   * entry ended must not report it twice.
   */
  private consumeNannyExit(entry: Entry): void {
    const statePath = nannyStatePath(this.options.nannyDir, entry.config.id)
    const state = readNannyState(statePath)
    if (state?.lastExit !== undefined)
      entry.nannyExit = state.lastExit
    clearNannyState(statePath)
    // A nanny writes its last lines and exits in one breath, so its final output is
    // read here rather than left between two relay polls. A crash on start is exactly
    // the case that fits in that gap — and the lines are the only explanation.
    this.drainRelay(entry)
  }

  /**
   * Announces the outcome of a force restart, once, the first moment the entry is serving.
   *
   * Every "it is up again" path calls this — spawn with no port, readiness accepted, and the
   * first healthy probe — and the pending flag makes it idempotent, so whichever happens
   * first is the one that reports.
   */
  private settleRestart(entry: Entry, detail: string): void {
    const pending = entry.pendingRestart
    if (pending === null)
      return
    entry.pendingRestart = null
    // The cause is repeated in the outcome: chat messages arrive out of order and hours
    // apart, so "back up" alone does not say what it came back from.
    const message = `after ${pending.cause}: ${detail}`
    this.log(entry, 'system', `restarted, and it is serving again — ${message}`)
    this.notify(entry, 'restart-ok', message)
  }

  /** One probe using the configured mode (TCP or HTTP), with timing. */
  private async probeEntryHealth(entry: Entry): Promise<{ healthy: boolean, ms: number, detail: string }> {
    const { port, health } = entry.config
    if (port === null)
      return { healthy: true, ms: 0, detail: 'no port configured' }

    return probeHealth({
      mode: health.mode,
      hosts: this.probeHosts(entry),
      port,
      timeoutMs: health.timeoutMs,
      http: health.http,
    })
  }

  private async awaitReadiness(entry: Entry, child: ChildProcess): Promise<void> {
    const { port, health } = entry.config

    if (port === null) {
      if (entry.child !== child || entry.status !== 'starting')
        return
      entry.status = 'running'
      entry.health = health.enabled ? 'unknown' : 'disabled'
      this.log(entry, 'system', 'running (no port configured; readiness assumed on spawn)')
      this.settleRestart(entry, 'it spawned and is running')
      this.publishServer(entry)
      return
    }

    const deadline = Date.now() + health.startTimeoutMs
    while (Date.now() < deadline) {
      if (entry.child !== child || entry.status !== 'starting' || this.disposed)
        return
      if (await this.portAccepts(entry, port, Math.min(health.timeoutMs, 1000))) {
        entry.portState = 'in-use'
        // A TCP accept is the whole probe in `port` mode, but only the *first half* of one in
        // `http` mode: the server is listening, and may still answer 500 to every request. Calling
        // that `healthy` made `dependsOn` release a dependent against a dependency that could not
        // serve, which is the ordering it exists to prevent. In http mode the first real probe
        // decides, so this leaves `unknown` and `probeEntry` reports what it finds.
        entry.health = !health.enabled ? 'disabled' : health.mode === 'http' ? 'unknown' : 'healthy'
        entry.status = 'running'
        entry.lastProbeAt = 0
        this.log(entry, 'system', `accepting connections on port ${port}`)
        // `port` mode: the accept *is* the health answer, so the restart's outcome is known.
        // `http` mode: it is not — announcing "serving again" here told the chat a server was
        // back while it answered 500 to everything, and the real probe below says so instead.
        if (health.mode !== 'http')
          this.settleRestart(entry, `accepting connections on port ${port}`)
        this.publishServer(entry)
        return
      }
      await delay(300)
    }

    if (entry.child === child && entry.status === 'starting') {
      entry.status = 'running'
      entry.health = 'unhealthy'
      entry.unhealthySince = Date.now()
      this.log(entry, 'system', `no connection on port ${port} after ${health.startTimeoutMs}ms — supervising anyway`)
      this.publishServer(entry)
    }
  }

  private handleExit(entry: Entry, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (entry.child !== child)
      return
    if (entry.pid !== null)
      this.sampler.forget(entry.pid)
    // A persistent entry's nanny is only a mirror of the real process: its own exit
    // code says nothing, so the state file is read before the reason is decided.
    if (entry.config.persistent)
      this.consumeNannyExit(entry)
    const nannyExit = entry.nannyExit
    entry.nannyExit = null

    entry.child = null
    entry.pid = null
    entry.adopted = false
    entry.resources = null
    entry.responseMs = null
    // Health describes a *process*. Left alone it outlives the process and lies: a dead entry
    // whose port a stranger still holds kept the last `healthy` verdict, so a crashed server read
    // as green while nothing of its own was running. Reset with the measurements beside it.
    entry.health = entry.config.health.enabled ? 'unknown' : 'disabled'
    entry.exitCode = code
    entry.exitSignal = signal

    // The child is known to have exited, so a later boot must not chase this pid: pids are
    // recycled, and a record kept past the process it names is a false adoption waiting.
    this.forgetRecordedChild(entry, child.pid ?? null)

    // Both null means the process never got off the ground — a missing command,
    // for instance — so its error is more useful than "code null".
    const neverStarted = nannyExit !== null
      ? nannyExit.code === null && nannyExit.signal === null
      : code === null && signal === null && entry.lastError !== null
    const detail = neverStarted
      ? (entry.lastError ?? 'the entry could not start')
      // Both exits go through one formatter. This branch used to hand-roll `code ${code}`, so a
      // supervised entry's log read "exited with code 137" while a nanny-run one got the hint
      // explaining it — the same event, described differently depending on how it was run.
      : nannyExit !== null
        ? describeNannyExit(nannyExit)
        : describeNannyExit({ code, signal, runtimeMs: 0, at: Date.now() } as NannyExit)
    const ranForMs = nannyExit?.runtimeMs ?? (entry.startedAt === null ? 0 : Date.now() - entry.startedAt)

    // Recorded for *every* exit, not only the ones that end in `crashed`: the
    // rolling window (crashes, uptime, last exit) is built from these events. A removed
    // entry is the exception: its history was reclaimed, and this is the stop that follows.
    if (!entry.removed) {
      this.options.history.record(entry.config.id, {
        type: 'exit',
        detail,
        runtimeMs: ranForMs,
      })
    }

    this.afterExit(entry, detail, ranForMs, neverStarted)
  }

  /**
   * What happens once a process is gone, whether it was a child we spawned or a
   * detached successor we adopted: back off and retry, or record the crash.
   */
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
    // Written before the retry decision below: whether the entry retries or gives up,
    // the attempt that just failed must be on disk before the panel could die again.
    this.persistEntryState(entry)

    this.log(entry, 'system', neverStarted ? `did not start: ${detail}` : `exited with ${detail} after ${ranFor}`)
    entry.lastError = neverStarted ? detail : `exited with ${detail}`

    if (restart.enabled && entry.restarts < restart.maxRetries) {
      entry.restarts += 1
      this.persistEntryState(entry)
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
      // Its outcome is no longer "it will come back": the crash below is the answer, and a
      // flag left standing would announce a recovery this restart never had.
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

    await this.sampleResources(now)
    // Cheap when nothing changed (a readdir); the birth check per pid only runs for state files no
    // entry owns, which is normally none.
    await this.refreshOrphans().catch((error: unknown) => {
      logger.warn('could not refresh the orphaned-process list', error)
    })

    // Probes run concurrently: one slow server must not delay the others' health.
    await Promise.allSettled([...this.entries.values()].map(entry => this.probeEntry(entry, now)))

    for (const entry of this.entries.values()) {
      // An adopted process is not our child, so nothing tells us it died.
      if (entry.adopted && entry.pid !== null && !isProcessAlive(entry.pid)) {
        this.handleAdoptedExit(entry)
        continue
      }
      if (await this.enforceMemoryLimit(entry))
        continue
      if (this.healthBudgetSpent(entry)) {
        await this.giveUpOnHealth(entry)
        continue
      }
      if (this.shouldForceRestart(entry, now)) {
        await this.restart(entry.config.id)
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

  /** One scan of /proc covers every server; only live processes are sampled. */
  private async sampleResources(now: number): Promise<void> {
    const due = [...this.entries.values()].filter(entry =>
      entry.pid !== null
      && (entry.child !== null || entry.adopted)
      && now - entry.resourcesSampledAt >= RESOURCE_SAMPLE_INTERVAL_MS)
    if (due.length === 0)
      return

    for (const entry of due) entry.resourcesSampledAt = now
    try {
      const samples = await this.sampler.sampleMany(due.map(entry => entry.pid!))
      for (const entry of due) entry.resources = samples.get(entry.pid!) ?? null
    }
    catch {
      // Sampling is best effort; a missing /proc must not break supervision.
    }
  }

  private async probeEntry(entry: Entry, now: number): Promise<void> {
    const { port, health } = entry.config
    if (port === null || entry.probing)
      return

    entry.probing = true
    try {
      // Occupancy is shown even while stopped, so it keeps its own slower cadence
      // instead of sharing (and being skipped by) the health probe's timer.
      if (now - entry.lastOccupancyProbeAt >= PORT_STATE_INTERVAL_MS) {
        entry.lastOccupancyProbeAt = now
        const accepting = await this.portAccepts(entry, port, health.timeoutMs)
        entry.portState = accepting ? 'in-use' : 'free'
      }

      if (entry.status !== 'running' || !health.enabled)
        return
      if (now - entry.lastProbeAt < health.intervalMs)
        return

      const probe = await this.probeEntryHealth(entry)
      entry.lastProbeAt = now
      entry.responseMs = probe.ms
      entry.portState = probe.healthy ? 'in-use' : entry.portState

      if (probe.healthy) {
        if (entry.health === 'unhealthy') {
          this.log(entry, 'system', `${probe.detail} — healthy again (${probe.ms}ms)`)
          this.options.history.record(entry.config.id, { type: 'recovered', detail: probe.detail })
          this.notify(entry, 'recovered', probe.detail)
        }
        // A force restart is announced before it happens, so its outcome has to be said too
        // — otherwise "came back fine" and "came back broken" look the same in the chat.
        // A restart that did *not* recover never reaches this branch, and its `crash` (or
        // the next `unhealthy`) is the answer instead.
        this.settleRestart(entry, `${probe.detail} (${probe.ms}ms)`)
        entry.health = 'healthy'
        entry.healthFailures = 0
        entry.unhealthySince = null
        // The budget refills on the same rule the crash counter uses: `restart.resetAfterMs` of
        // *uptime*, not one healthy probe. Resetting on the probe made the budget a per-life cap
        // of one — a server answering 500 after a single good response was force-restarted
        // forever, which is the loop the budget exists to stop.
        const servedForMs = entry.startedAt === null ? 0 : Date.now() - entry.startedAt
        if (entry.healthRestarts > 0 && servedForMs >= entry.config.restart.resetAfterMs) {
          entry.healthRestarts = 0
          this.persistEntryState(entry)
        }
        return
      }

      entry.healthFailures += 1
      if (entry.healthFailures >= health.unhealthyThreshold) {
        if (entry.unhealthySince === null) {
          entry.unhealthySince = now
          this.log(entry, 'system', `unhealthy: ${probe.detail} (${entry.healthFailures} failed probes) — warning only`)
          this.options.history.record(entry.config.id, { type: 'unhealthy', detail: probe.detail })
          this.notify(entry, 'unhealthy', probe.detail)
        }
        entry.health = 'unhealthy'
      }
    }
    finally {
      entry.probing = false
    }
  }

  private async enforceMemoryLimit(entry: Entry): Promise<boolean> {
    const limit = entry.config.resources.maxRssBytes
    const rss = entry.resources?.rssBytes ?? null
    if (limit <= 0 || rss === null || entry.child === null || entry.status !== 'running' || rss <= limit)
      return false

    const detail = `process tree uses ${Math.round(rss / 1024 / 1024)}MB, over the ${Math.round(limit / 1024 / 1024)}MB limit`
    this.log(entry, 'system', `${detail} — restarting`)
    this.options.history.record(entry.config.id, { type: 'forced-restart', detail })
    this.notify(entry, 'rss', detail)
    entry.pendingRestart = { cause: 'exceeding its memory limit' }
    await this.restart(entry.config.id)
    return true
  }

  private shouldForceRestart(entry: Entry, now: number): boolean {
    const { port, health, restart } = entry.config
    if (port === null || entry.status !== 'running' || entry.health !== 'unhealthy')
      return false
    if (entry.unhealthySince === null || health.forceRestartAfterMs <= 0)
      return false
    if (now - entry.unhealthySince < health.forceRestartAfterMs)
      return false

    // The crash path has always been bounded by `restart.maxRetries`; this one had no budget at
    // all, so an entry that stayed up and failed every probe was restarted forever. Same budget,
    // separate counter: a server that crashes is a different failure from one that cannot serve.
    if (!restart.enabled || entry.healthRestarts >= restart.maxRetries) {
      // Stopping is a side effect, so it cannot happen here (this is a predicate the tick calls).
      // The tick reads `healthBudgetSpent` and stops the entry once.
      return false
    }

    entry.healthRestarts += 1
    this.persistEntryState(entry)
    this.log(entry, 'system', `unhealthy for ${health.forceRestartAfterMs}ms — forcing a restart (${entry.healthRestarts}/${restart.maxRetries})`)
    this.options.history.record(entry.config.id, { type: 'forced-restart', detail: `health check stayed unhealthy` })
    this.notify(entry, 'forced-restart', `unhealthy for ${Math.round(health.forceRestartAfterMs / 1000)}s`)
    // The restart resets health, so this is the only place that remembers an outcome is owed.
    entry.pendingRestart = { cause: 'staying unhealthy through its health check' }
    return true
  }

  /** Whether this entry's health budget is spent, so the tick should stop it. */
  private healthBudgetSpent(entry: Entry): boolean {
    const { port, health, restart } = entry.config
    if (port === null || entry.status !== 'running' || entry.health !== 'unhealthy')
      return false
    if (entry.unhealthySince === null || health.forceRestartAfterMs <= 0)
      return false
    return !restart.enabled || entry.healthRestarts >= restart.maxRetries
  }

  /**
   * Stops an entry that cannot pass its own health check, once the restart budget is spent.
   *
   * `stopped` because the process really is stopped; the reason stays on `lastError`, so the card
   * and the notification still say why. Marking it `crashed` while leaving it running would report
   * a live pid and a serving port as down.
   */
  private async giveUpOnHealth(entry: Entry): Promise<void> {
    const budgetEnabled = entry.config.restart.enabled
    const detail = budgetEnabled
      ? `stopped after ${entry.config.restart.maxRetries} health restarts (the health check kept failing)`
      : 'stopped because health restarts are disabled and the health check is failing'

    entry.pendingRestart = null
    entry.healthRestarts = 0
    entry.stoppedByPanel = true
    this.log(entry, 'system', detail)
    // Recorded as a crash: the entry is down and stayed down, which is what the history means.
    this.options.history.record(entry.config.id, { type: 'crash', detail })
    this.notify(entry, 'crash', detail)
    await this.stopEntry(entry)
    // Set after the stop, because `stopEntry` clears `lastError` on the stopped path.
    if (!entry.removed) {
      entry.lastError = detail
      this.publishServer(entry)
    }
  }

  private clearRetry(entry: Entry): void {
    if (entry.retryTimer !== null) {
      clearTimeout(entry.retryTimer)
      entry.retryTimer = null
    }
  }

  /** The decisions that have to survive this panel, and nothing else. */
  private persistEntryState(entry: Entry): void {
    // A removed entry's state file was reclaimed with its logs and history, and the stop that
    // follows runs asynchronously — the child's `exit` lands after the removal, reaching
    // `forgetRecordedChild`. Writing there recreated the file, which is both stale state for a
    // re-added id and a file appearing while a caller walks the directory to delete it.
    if (entry.removed)
      return
    writeEntryState(entryStatePath(this.options.nannyDir, entry.config.id), {
      restarts: entry.restarts,
      healthRestarts: entry.healthRestarts,
      bootstrapDone: entry.bootstrapDone,
      // A persistent entry's nanny state is already its record; a second one could only
      // disagree with it, and `resumePersistent` reads the nanny's.
      lastPid: entry.config.persistent ? null : entry.lastChild?.pid ?? null,
      lastStartedAt: entry.config.persistent ? null : entry.lastChild?.startedAt ?? null,
    })
  }

  private buildVars(entry: Entry): TemplateVars {
    return serverTemplateVars(entry.config)
  }

  private view(entry: Entry): ServerView {
    const config = entry.config
    const host = displayHost(config.bind)
    return {
      id: config.id,
      workspaceId: this.options.workspaceId,
      config,
      bindHost: bindHost(config.bind),
      url: config.port === undefined || config.port === null ? null : `http://${host}:${config.port}`,
      status: entry.status,
      health: entry.health,
      portState: entry.portState,
      pid: entry.pid,
      // Omitted when false: an optional ArkType property rejects an explicit undefined.
      ...(entry.adopted ? { adopted: true } : {}),
      ...(entry.stoppedByPanel ? { stoppedByPanel: true } : {}),
      startedAt: entry.startedAt,
      exitCode: entry.exitCode,
      exitSignal: entry.exitSignal,
      restarts: entry.restarts,
      maxRetries: config.restart.maxRetries,
      lastError: entry.lastError,
      nextRetryAt: entry.nextRetryAt,
      unhealthySince: entry.unhealthySince,
      bufferedLines: entry.logs.size,
      history: this.summarizeHistory(entry),
      responseMs: entry.responseMs,
      resources: entry.resources,
    }
  }

  private log(entry: Entry, stream: LogStream, text: string): void {
    // A removed entry's artifacts were reclaimed the moment the config dropped it, so the stop that
    // follows must not append to them: it would recreate a log file and a history the removal just
    // deleted. The reason survives on the console instead, where an operator can still read it.
    if (entry.removed) {
      logger.debug(`[${entry.config.id}] ${text}`)
      return
    }
    const line: LogLine = { ts: Date.now(), stream, text }
    entry.logs.push(line)
    this.options.logFiles.append(entry.config.id, line)
    // The relay reads that same file back, so this line has to be recognizable later
    // as ours. Only a persistent entry's log is a file the panel both writes and tails.
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

  /**
   * Hand the panel the signal that something moved. The panel diffs the whole
   * aggregate state — every workspace's servers, DDNS and host vitals — and
   * publishes at most one frame, so a noisy workspace cannot multiply frames.
   */
  private publishState(): void {
    this.options.onStateChange()
  }
}
