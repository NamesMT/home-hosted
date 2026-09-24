import type { ChildProcess } from 'node:child_process'
import type { ServerConfig } from '#src/config/schema'
import type { ConfigStore } from '#src/config/store'
import type { TemplateVars } from '#src/helpers/template'
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
  PortState,
  ProcessResources,
  ServerStatus,
  ServerView,
} from '#src/shared/contracts'
import { spawn } from 'node:child_process'
import os from 'node:os'
import process from 'node:process'
import { computeBackoff } from '#src/helpers/backoff'
import { bindHost, displayHost, lanAddress } from '#src/helpers/bind'
import { expandEnvList, expandEnvRecord, loadEnvFile, resolveEnvFilePath } from '#src/helpers/env-file'
import { logger } from '#src/helpers/logger'
import { dataRoot, projectDir } from '#src/helpers/paths'
import { resolveRecord, resolveTemplates } from '#src/helpers/template'
import { probeHealth } from '#src/providers/health-check'
import { isPortFree, killPortHolders, listPortHolders, probePort, terminatePids } from '#src/providers/port'
import { ProcessSampler } from '#src/providers/proc'
import { resolveCommand, resolveCwd, spawnManaged, terminate } from '#src/providers/process'
import { dependenciesOf, orderByDependencies } from '#src/services/dependencies'
import { LineSplitter, LogBuffer } from '#src/services/log-buffer'

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
}

/** Uptime/crash counters are reported over this window. */
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000
const HISTORY_CACHE_MS = 5000

export interface StartResult {
  ok: boolean
  error?: string
}

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
  private readonly entries = new Map<string, Entry>()
  private readonly tickTimer: NodeJS.Timeout
  private disposed = false
  private lastStateSignature = ''

  constructor(
    private readonly store: ConfigStore,
    private readonly hub: EventHub,
    private readonly options: SupervisorOptions,
  ) {
    this.sync()
    this.store.onChange(() => this.sync())
    this.tickTimer = setInterval(() => void this.tick(), TICK_INTERVAL_MS)
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
    const targets = [...this.entries.values()]
      .filter(entry => !options.autostartOnly || entry.config.autostart)
      .map(entry => entry.config)
    // Dependencies first; levels are still started concurrently.
    for (const config of orderByDependencies(targets)) {
      await this.start(config.id)
    }
  }

  async stopAll(): Promise<void> {
    const targets = orderByDependencies([...this.entries.values()].map(entry => entry.config)).reverse()
    for (const config of targets) {
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

      await this.runBootstrap(entry)
      if (entry.stopping)
        return { ok: false, error: `server "${id}" is stopping` }
      if (this.disposed)
        return { ok: false, error: 'supervisor is shutting down' }

      const conflict = await this.preflight(entry)
      if (conflict !== null)
        return { ok: false, error: conflict }

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

    const supervised = this.supervisedPids()
    const holders = await listPortHolders(port)
    const ours = holders.filter(pid => supervised.has(pid))
    const foreign = holders.filter(pid => !supervised.has(pid))

    if (holders.length === 0)
      return { ...empty, port, error: `nothing is listening on port ${port} any more` }
    if (foreign.length === 0) {
      const reason = `port ${port} is held by pid ${ours.join(', ')}, which this panel supervises — stop that server instead`
      return { ...empty, port, error: reason, skipped: ours }
    }

    this.log(entry, 'system', `freeing port ${port}: asking pid ${foreign.join(', ')} to stop`)
    const { stopped, forced } = await terminatePids(foreign)
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

  /** Pids of the child processes this panel owns, plus itself. */
  private supervisedPids(): Set<number> {
    const pids = new Set<number>([process.pid])
    for (const entry of this.entries.values()) {
      if (entry.pid !== null)
        pids.add(entry.pid)
    }
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
    await Promise.all([...this.entries.values()].map(entry => this.stopEntry(entry)))
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

    if (entry.child === null) {
      entry.status = 'stopped'
      entry.pid = null
      this.publishServer(entry)
      return { ok: true }
    }

    entry.status = 'stopping'
    this.publishServer(entry)

    const outcome = await terminate(entry.child, entry.config.stop)
    if (outcome === 'force-killed')
      this.log(entry, 'system', 'force-killed after grace period')

    const { port, stop } = entry.config
    if (stop.killPortHolders && port !== null) {
      const leftover = await listPortHolders(port)
      if (leftover.length > 0) {
        this.log(entry, 'system', `port ${port} still held by pid ${leftover.join(', ')} — killing`)
        await killPortHolders(port)
      }
    }

    entry.stopping = false
    entry.child = null
    entry.pid = null
    entry.status = 'stopped'
    this.log(entry, 'system', 'stopped')
    this.publishServer(entry)
    return { ok: true }
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
        void this.stopEntry(entry)
        continue
      }
      const bufferChanged = entry.config.logBufferLines !== config.logBufferLines
      entry.config = config
      if (bufferChanged) {
        const kept = entry.logs.list(config.logBufferLines)
        entry.logs = new LogBuffer(config.logBufferLines)
        entry.logs.extend(kept)
      }
      if (!config.enabled && this.isActive(entry))
        void this.stopEntry(entry)
    }

    for (const [id, config] of wanted) {
      if (!this.entries.has(id))
        this.entries.set(id, this.createEntry(config))
    }

    this.publishState()
  }

  private isActive(entry: Entry): boolean {
    return entry.child !== null || entry.status === 'backoff'
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

  private async preflight(entry: Entry): Promise<string | null> {
    const port = entry.config.port
    if (port === null)
      return null

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
      return null

    const holders = await listPortHolders(port)
    const suffix = holders.length > 0 ? ` (pid ${holders.join(', ')})` : ''

    if (entry.config.onPortConflict === 'block') {
      entry.status = 'conflict'
      entry.lastError = `port ${port} is already in use${suffix}`
      this.log(entry, 'system', `${entry.lastError} — not starting (onPortConflict: block)`)
      this.publishServer(entry)
      return entry.lastError
    }

    this.log(entry, 'system', `warning: port ${port} is already in use${suffix} — starting anyway`)
    return null
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

  private spawnEntry(entry: Entry): StartResult {
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
    const args = expandEnvList(resolveTemplates(entry.config.args, vars), expansionVars)
    const env = {
      // `envFile` is the machine-local layer, so it overrides the tracked `env`.
      ...expandEnvRecord(resolveRecord(entry.config.env, vars), expansionVars),
      ...fileEnv,
      // Data envs win over `env`: their value is the directory that gets backed
      // up, so the process has to be pointed at exactly that path.
      ...expandEnvRecord(resolveRecord(entry.config.dataEnvs, vars), expansionVars),
      HHOSTED_SERVER_ID: entry.config.id,
      HHOSTED_CONTROL_PORT: String(this.options.control.port),
    }

    // Logged *before* `${VAR}` expansion: an argument like `${API_TOKEN}` must not
    // land in the ring buffer, the rotated files, SSE or Telegram.
    this.log(entry, 'system', `start: ${command} ${resolveTemplates(entry.config.args, vars).join(' ')}`)

    let child: ChildProcess
    try {
      child = spawnManaged({ command, args, cwd, env })
    }
    catch (error) {
      entry.status = 'crashed'
      entry.lastError = (error as Error).message
      this.log(entry, 'system', `spawn failed: ${entry.lastError}`)
      this.publishServer(entry)
      return { ok: false, error: entry.lastError }
    }

    entry.child = child
    entry.pid = child.pid ?? null
    entry.startedAt = Date.now()
    this.options.history.record(entry.config.id, {
      type: 'start',
      detail: `${command} ${args.join(' ')}`.trim(),
    })
    entry.exitCode = null
    entry.exitSignal = null
    entry.lastProbeAt = 0
    entry.healthFailures = 0
    entry.unhealthySince = null
    this.publishServer(entry)

    const stdout = new LineSplitter((stream, text) => this.log(entry, stream, text))
    const stderr = new LineSplitter((stream, text) => this.log(entry, stream, text))
    child.stdout?.on('data', chunk => stdout.push('stdout', chunk))
    child.stderr?.on('data', chunk => stderr.push('stderr', chunk))

    child.once('error', (error) => {
      entry.lastError = (error as Error).message
      this.log(entry, 'system', `process error: ${entry.lastError}`)
      stdout.flush('stdout')
      stderr.flush('stderr')
      this.handleExit(entry, child, null, null)
    })

    child.once('exit', (code, signal) => {
      stdout.flush('stdout')
      stderr.flush('stderr')
      this.handleExit(entry, child, code, signal)
    })

    void this.awaitReadiness(entry, child)
    return { ok: true }
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
    entry.child = null
    entry.pid = null
    entry.resources = null
    entry.responseMs = null
    entry.exitCode = code
    entry.exitSignal = signal

    // Both null means the process never got off the ground — a missing command,
    // for instance — so its error is more useful than "code null".
    const neverStarted = code === null && signal === null && entry.lastError !== null
    const detail = neverStarted
      ? entry.lastError!
      : signal !== null ? `signal ${signal}` : `code ${code}`
    const ranForMs = entry.startedAt === null ? 0 : Date.now() - entry.startedAt
    const ranFor = `${Math.max(1, Math.round(ranForMs / 1000))}s`

    // Recorded for *every* exit, not only the ones that end in `crashed`: the
    // rolling window (crashes, uptime, last exit) is built from these events.
    this.options.history.record(entry.config.id, {
      type: 'exit',
      detail,
      runtimeMs: ranForMs,
    })

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
        void this.start(entry.config.id, { retry: true })
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
      if (await this.enforceMemoryLimit(entry))
        continue
      if (this.shouldForceRestart(entry, now)) {
        await this.restart(entry.config.id)
        continue
      }
      if (entry.status === 'backoff' && entry.nextRetryAt !== null && now >= entry.nextRetryAt && entry.retryTimer === null)
        void this.start(entry.config.id, { retry: true })
    }

    this.publishState()
  }

  /** One scan of /proc covers every server; only live processes are sampled. */
  private async sampleResources(now: number): Promise<void> {
    const due = [...this.entries.values()].filter(entry =>
      entry.pid !== null
      && entry.child !== null
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
