import type { ChildProcess } from 'node:child_process'
import type { ServerConfig } from '#src/config/schema'
import type { ConfigStore } from '#src/config/store'
import type { TemplateVars } from '#src/helpers/template'
import type { SpawnInfo } from '#src/providers/identity'
import type { ControlEndpoint } from '#src/services/control-server'
import type { EventHub } from '#src/services/events'
import type { HistoryStore } from '#src/services/history'
import type { HostMonitor } from '#src/services/host-monitor'
import type { LogFiles } from '#src/services/log-files'
import type { NotificationReason, NotificationService } from '#src/services/notifications'
import type {
  AppState,
  FreePortResult,
  HealthState,
  LogLine,
  LogStream,
  NannyExit,
  NannySpec,
  PortState,
  ProcessResources,
  ServerStatus,
  ServerView,
} from '#src/shared/contracts'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { computeBackoff } from '#src/helpers/backoff'
import { bindHost, displayHost, lanAddress } from '#src/helpers/bind'
import { expandEnvList, expandEnvRecord, loadEnvFile, resolveEnvFilePath } from '#src/helpers/env-file'
import { logger } from '#src/helpers/logger'
import { dataRoot, projectDir } from '#src/helpers/paths'
import { nannyArgv } from '#src/helpers/runtime'
import { resolveRecord, resolveTemplates } from '#src/helpers/template'
import { probeHealth } from '#src/providers/health-check'
import { identifyHolders } from '#src/providers/identity'
import {
  clearNannySpec,
  clearNannyState,
  describeNannyExit,
  nannyEntryPoint,
  nannyIsAlive,
  nannyLogFile,
  nannySpecPath,
  nannyStatePath,
  readNannyState,
  sweepNannySpecs,
  writeNannySpec,
} from '#src/providers/nanny'
import { isPortFree, isProcessAlive, killPortHolders, listPortHolders, probePort, terminatePids } from '#src/providers/port'
import { ProcessSampler, processTreePids } from '#src/providers/proc'
import { resolveCommand, resolveCwd, spawnManaged, terminate, terminatePid } from '#src/providers/process'
import { dependenciesOf, orderByDependencies } from '#src/services/dependencies'
import { LineSplitter, LogBuffer } from '#src/services/log-buffer'
import { LogRelay } from '#src/services/log-relay'

export interface SupervisorOptions {
  configPath: string
  /** Live listener info, mutated by the control server when it rebinds. */
  control: ControlEndpoint
  /** Injected so SSE state frames carry the same view the API serves. */
  buildState: (views: ServerView[]) => AppState
  history: HistoryStore
  logFiles: LogFiles
  notifications: NotificationService
  hostMonitor: HostMonitor
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

interface Entry {
  config: ServerConfig
  status: ServerStatus
  health: HealthState
  portState: PortState
  child: ChildProcess | null
  pid: number | null
  startedAt: number | null
  exitCode: number | null
  exitSignal: string | null
  restarts: number
  lastError: string | null
  nextRetryAt: number | null
  retryTimer: NodeJS.Timeout | null
  healthFailures: number
  unhealthySince: number | null
  lastProbeAt: number
  lastOccupancyProbeAt: number
  probing: boolean
  /** The running process is a detached successor we adopted, not a child we spawned. */
  adopted: boolean
  /**
   * How the child of a persistent entry ended, read from its nanny's state file: the
   * panel was not its parent, so `code`/`signal` of the *nanny* are only a mirror.
   */
  nannyExit: NannyExit | null
  /** A start is in flight (set synchronously, unlike `status`). */
  starting: boolean
  stopping: boolean
  bootstrapDone: boolean
  logs: LogBuffer
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
  private readonly tickTimer: NodeJS.Timeout
  private disposed = false
  private lastStateSignature = ''

  constructor(
    private readonly store: ConfigStore,
    private readonly hub: EventHub,
    private readonly options: SupervisorOptions,
  ) {
    // A spec on disk belongs to a nanny that never read it: nothing this process has
    // spawned yet can be waiting for one, and it holds expanded env.
    const swept = sweepNannySpecs(this.options.nannyDir)
    if (swept > 0)
      logger.warn(`removed ${swept} unread nanny spec file(s) from ${this.options.nannyDir}`)

    this.sync()
    this.store.onChange(() => this.sync())
    // A throw inside the tick must not become an unhandled rejection: on Node 24
    // that ends the process, and this timer is what keeps every server watched.
    this.tickTimer = setInterval(() => {
      void this.tick().catch((error: unknown) => logger.error('the supervisor tick failed', error))
    }, TICK_INTERVAL_MS)
    this.tickTimer.unref()
  }

  getState(): AppState {
    return this.options.buildState(this.views())
  }

  views(): ServerView[] {
    return [...this.entries.values()].map(entry => this.view(entry))
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
    // Dependencies first; levels are still started concurrently.
    for (const config of orderByDependencies(targets)) {
      await this.start(config.id)
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

  async start(id: string, options: { retry?: boolean } = {}): Promise<StartResult> {
    const entry = this.entries.get(id)
    if (!entry)
      return { ok: false, error: `unknown server "${id}"` }
    if (!entry.config.enabled)
      return { ok: false, error: `server "${id}" is disabled` }
    if (entry.status === 'running' || entry.status === 'starting' || entry.starting)
      return { ok: true }
    if (entry.stopping)
      return { ok: false, error: `server "${id}" is stopping` }

    // Set before the first await: two overlapping `start()` calls (a click and a
    // retry timer, say) would otherwise both reach `spawnEntry` and orphan one.
    entry.starting = true
    this.clearRetry(entry)
    if (!options.retry) {
      entry.restarts = 0
      entry.healthFailures = 0
      entry.unhealthySince = null
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

      await this.runBootstrap(entry)
      if (entry.stopping)
        return { ok: false, error: `server "${id}" is stopping` }
      if (this.disposed)
        return { ok: false, error: 'supervisor is shutting down' }

      const conflict = await this.preflight(entry)
      if (conflict.kind === 'blocked')
        return { ok: false, error: conflict.error }
      if (conflict.kind === 'adopt')
        return this.adoptEntry(entry, conflict.pid)

      return this.spawnEntry(entry)
    }
    finally {
      entry.starting = false
    }
  }

  async stop(id: string): Promise<StartResult> {
    const entry = this.entries.get(id)
    if (!entry)
      return { ok: false, error: `unknown server "${id}"` }
    return this.stopEntry(entry)
  }

  async restart(id: string): Promise<StartResult> {
    await this.stop(id)
    return this.start(id)
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
      return { ...empty, error: `unknown server "${id}"` }

    const port = entry.config.port
    if (port === null)
      return { ...empty, error: `server "${id}" has no port configured` }
    if (entry.starting || entry.stopping)
      return { ...empty, port, error: `server "${id}" is busy — try again in a moment` }

    const { ours, foreign } = await this.portHolders(port)
    const holders = [...ours, ...foreign]

    if (holders.length === 0)
      return { ...empty, port, error: `nothing is listening on port ${port} any more` }
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
      if (target.status === 'running' || target.child !== null)
        continue

      this.log(entry, 'system', `starting dependency "${dependency.id}" first`)
      await this.start(dependency.id)

      const deadline = Date.now() + dependency.health.startTimeoutMs
      const isReady = (): boolean => {
        const status = this.statusOf(target)
        if (status !== 'running')
          return false
        // A dependency that is listening but failing its check is not ready.
        return target.health !== 'unhealthy'
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

    if (entry.child === null && entry.pid === null) {
      entry.stopping = false
      entry.status = 'stopped'
      this.publishServer(entry)
      return { ok: true }
    }

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
      this.relay.unfollow(entry.config.id)
    }

    entry.stopping = false
    entry.child = null
    entry.pid = null
    entry.adopted = false
    entry.nannyExit = null
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
    return {
      config,
      status: 'stopped',
      health: config.health.enabled ? 'unknown' : 'disabled',
      portState: 'unknown',
      child: null,
      pid: null,
      startedAt: null,
      exitCode: null,
      exitSignal: null,
      restarts: 0,
      lastError: null,
      nextRetryAt: null,
      retryTimer: null,
      healthFailures: 0,
      unhealthySince: null,
      lastProbeAt: 0,
      lastOccupancyProbeAt: 0,
      probing: false,
      adopted: false,
      nannyExit: null,
      starting: false,
      stopping: false,
      bootstrapDone: !config.bootstrap,
      logs: new LogBuffer(config.logBufferLines),
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
        void this.stopEntry(entry).catch((error: unknown) => {
          logger.error(`could not stop the removed server ${id}`, error)
        })
        continue
      }
      const bufferChanged = entry.config.logBufferLines !== config.logBufferLines
      entry.config = config
      // The flag decides how the entry is *run*, so it takes effect on the next start;
      // what must not linger is a tailer for an entry that is no longer persistent.
      if (!config.persistent)
        this.relay.unfollow(id)
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
    const suffix = holders.length > 0 ? ` (pid ${holders.join(', ')})` : ''

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
        // The probe says busy but no listener could be listed: let the start decide.
        this.log(entry, 'system', `port ${port} looks busy but no listener could be found — starting anyway`)
        return { kind: 'free' }
      }

      this.log(entry, 'system', `port ${port} is held by pid ${foreign.join(', ')} — onPortConflict: kill, stopping the holder`)
      const { forced } = await terminatePids(foreign, { graceMs: entry.config.stop.graceMs })
      if (forced.length > 0)
        this.log(entry, 'system', `pid ${forced.join(', ')} ignored SIGTERM and was killed`)

      await delay(PORT_RELEASE_RECHECK_MS)
      if (await freeOnAll()) {
        entry.portState = 'free'
        return { kind: 'free' }
      }
      entry.status = 'conflict'
      entry.lastError = `port ${port} is still in use after killing pid ${foreign.join(', ')}`
      this.log(entry, 'system', entry.lastError)
      this.publishServer(entry)
      return { kind: 'blocked', error: entry.lastError }
    }

    // A detached restart of this same server. Following it keeps whatever the program
    // set up (at the cost of its output, which belongs to whoever spawned it);
    // reclaiming the port buys back a fully supervised process instead.
    if (own !== null && entry.config.onPortConflict === 'follow')
      return { kind: 'adopt', pid: own }

    if (own !== null && entry.config.onPortConflict === 'reclaim') {
      this.log(entry, 'system', `port ${port} is held by pid ${own}, a detached restart of this entry — replacing it with a supervised process`)
      const { forced } = await terminatePids([own], { graceMs: entry.config.stop.graceMs })
      if (forced.length > 0)
        this.log(entry, 'system', `pid ${forced.join(', ')} ignored SIGTERM and was killed`)
      await delay(PORT_RELEASE_RECHECK_MS)
      if (await freeOnAll()) {
        entry.portState = 'free'
        return { kind: 'free' }
      }
      entry.status = 'conflict'
      entry.lastError = `port ${port} is still in use after replacing pid ${own}`
      this.log(entry, 'system', entry.lastError)
      this.publishServer(entry)
      return { kind: 'blocked', error: entry.lastError }
    }

    const hint = own !== null
      ? ` — pid ${own} is a detached restart of this entry: set onPortConflict to "follow" to adopt it, "reclaim" to replace it with a supervised process, or "kill" to stop whatever holds the port`
      : ''

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
   * Takes over a detached successor: no spawn, no duplicate. The pid is supervised
   * from here on (liveness, health probe, resources, stop), while its output stays
   * wherever it was redirected.
   *
   * For a persistent entry that output is not a mystery: its nanny is still writing
   * the entry's log file, so the relay is started here too. Without this, adopting a
   * persistent entry whose state file was lost would show its history but never
   * another live line.
   */
  private adoptEntry(entry: Entry, pid: number): StartResult {
    entry.adopted = true
    entry.pid = pid
    entry.child = null
    entry.status = 'running'
    entry.health = entry.config.health.enabled ? 'unknown' : 'disabled'
    entry.startedAt = Date.now()
    entry.lastError = null
    this.log(entry, 'system', `adopted pid ${pid}: a detached restart of this entry is already serving port ${entry.config.port}`)
    if (entry.config.persistent)
      this.followPersistent(entry)
    this.publishServer(entry)
    return { ok: true }
  }

  /** An adopted successor disappeared: fall back to the normal lifecycle. */
  private handleAdoptedExit(entry: Entry): void {
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
    entry.resources = null
    entry.responseMs = null
    entry.exitCode = null
    entry.exitSignal = null
    this.options.history.record(entry.config.id, {
      type: 'exit',
      detail,
      runtimeMs: ranForMs,
    })
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

    const child = spawn(resolveCommand(spec.command, cwd, projectDir), args, {
      cwd,
      env: { ...process.env, ...resolveRecord(spec.env, vars) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
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
    this.options.history.record(entry.config.id, { type: 'start', detail })
    entry.exitCode = null
    entry.exitSignal = null
    entry.nannyExit = null
    entry.lastProbeAt = 0
    entry.healthFailures = 0
    entry.unhealthySince = null
    this.publishServer(entry)

    child.once('error', (error) => {
      entry.lastError = (error as Error).message
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

    for (const line of lines) entry.logs.push(line)
    // One frame per batch: this is a file tail, and a burst of lines would otherwise
    // become a burst of frames.
    this.hub.publish({ type: 'log', ts: lines[lines.length - 1]!.ts, serverId, lines })
  }

  /**
   * Follows a persistent entry's log file, filling the ring buffer from what is on disk.
   *
   * The backfill is read *through* the tailer, which is the only thing that may own the
   * offset: reading it from `LogFiles` first and seeking to EOF second would either
   * replay a line as news or skip one as history, depending on which order the two
   * syscalls happen to land in.
   */
  private followPersistent(entry: Entry): void {
    const id = entry.config.id
    // `logs.persist: false` means that history is not served, and the backfill follows suit.
    const backfill = entry.logs.size === 0 && this.options.logFiles.config.persist
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
      this.log(entry, 'system', `persistent: still running (nanny pid ${state.nannyPid}${child}) — reattached`)
      this.followPersistent(entry)
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
    this.relay.unfollow(entry.config.id)
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
      this.publishServer(entry)
      return
    }

    const deadline = Date.now() + health.startTimeoutMs
    while (Date.now() < deadline) {
      if (entry.child !== child || entry.status !== 'starting' || this.disposed)
        return
      if (await this.portAccepts(entry, port, Math.min(health.timeoutMs, 1000))) {
        entry.portState = 'in-use'
        entry.health = health.enabled ? 'healthy' : 'disabled'
        entry.status = 'running'
        entry.lastProbeAt = Date.now()
        this.log(entry, 'system', `accepting connections on port ${port}`)
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
    entry.exitCode = code
    entry.exitSignal = signal

    // Both null means the process never got off the ground — a missing command,
    // for instance — so its error is more useful than "code null".
    const neverStarted = nannyExit !== null
      ? nannyExit.code === null && nannyExit.signal === null
      : code === null && signal === null && entry.lastError !== null
    const detail = neverStarted
      ? (entry.lastError ?? 'the entry could not start')
      : nannyExit !== null
        ? describeNannyExit(nannyExit)
        : signal !== null ? `signal ${signal}` : `code ${code}`
    const ranForMs = nannyExit?.runtimeMs ?? (entry.startedAt === null ? 0 : Date.now() - entry.startedAt)

    // Recorded for *every* exit, not only the ones that end in `crashed`: the
    // rolling window (crashes, uptime, last exit) is built from these events.
    this.options.history.record(entry.config.id, {
      type: 'exit',
      detail,
      runtimeMs: ranForMs,
    })

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

    this.log(entry, 'system', neverStarted ? `did not start: ${detail}` : `exited with ${detail} after ${ranFor}`)
    entry.lastError = neverStarted ? detail : `exited with ${detail}`

    if (restart.enabled && entry.restarts < restart.maxRetries) {
      entry.restarts += 1
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

    await this.options.hostMonitor.tick(now)
    await this.sampleResources(now)

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
        entry.health = 'healthy'
        entry.healthFailures = 0
        entry.unhealthySince = null
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
    await this.restart(entry.config.id)
    return true
  }

  private shouldForceRestart(entry: Entry, now: number): boolean {
    const { port, health } = entry.config
    if (port === null || entry.status !== 'running' || entry.health !== 'unhealthy')
      return false
    if (entry.unhealthySince === null || health.forceRestartAfterMs <= 0)
      return false
    if (now - entry.unhealthySince < health.forceRestartAfterMs)
      return false

    this.log(entry, 'system', `unhealthy for ${health.forceRestartAfterMs}ms — forcing a restart`)
    this.options.history.record(entry.config.id, { type: 'forced-restart', detail: `health check stayed unhealthy` })
    this.notify(entry, 'forced-restart', `unhealthy for ${Math.round(health.forceRestartAfterMs / 1000)}s`)
    return true
  }

  private clearRetry(entry: Entry): void {
    if (entry.retryTimer !== null) {
      clearTimeout(entry.retryTimer)
      entry.retryTimer = null
    }
  }

  private buildVars(entry: Entry): TemplateVars {
    return serverTemplateVars(entry.config)
  }

  private view(entry: Entry): ServerView {
    const config = entry.config
    const host = displayHost(config.bind)
    return {
      id: config.id,
      config,
      bindHost: bindHost(config.bind),
      url: config.port === undefined || config.port === null ? null : `http://${host}:${config.port}`,
      status: entry.status,
      health: entry.health,
      portState: entry.portState,
      pid: entry.pid,
      // Omitted when false: an optional ArkType property rejects an explicit undefined.
      ...(entry.adopted ? { adopted: true } : {}),
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
    const line: LogLine = { ts: Date.now(), stream, text }
    entry.logs.push(line)
    this.options.logFiles.append(entry.config.id, line)
    this.hub.publish({ type: 'log', ts: line.ts, serverId: entry.config.id, lines: [line] })
    if (stream === 'system')
      logger.debug(`[${entry.config.id}] ${text}`)
  }

  private publishServer(entry: Entry): void {
    if (!this.entries.has(entry.config.id))
      return
    this.hub.publish({
      type: 'server',
      ts: Date.now(),
      serverId: entry.config.id,
      server: this.view(entry),
    })
  }

  private publishState(): void {
    const state = this.getState()
    const signature = [
      state.configError ?? '',
      ...state.servers.map(server => [
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
        // nothing structural changes emits no frames at all — and every graph
        // stays empty until something else moves.
        server.responseMs,
        server.resources?.sampledAt,
      ].join(':')),
    ].join('|')

    if (signature === this.lastStateSignature)
      return
    this.lastStateSignature = signature
    this.hub.publish({ type: 'state', ts: Date.now(), state })
  }
}
