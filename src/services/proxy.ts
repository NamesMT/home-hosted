import type { ChildProcess } from 'node:child_process'
import type { GlobalSettingsStore } from '#src/config/settings'
import type { ProxyAdminTransport, ProxyEngine } from '#src/providers/proxy'
import type { ControlEndpoint } from '#src/services/control-server'
import type { TlsStore } from '#src/services/tls'
import type {
  ProxyConfig,
  ProxyEngineStatus,
  ProxyPatch,
  ProxyRouteView,
  ProxyRunState,
  ProxyStatus,
  ProxyView,
} from '#src/shared/contracts'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { writeFileAtomic } from '#src/helpers/atomic'
import { logger } from '#src/helpers/logger'
import { dataRoot, projectDir } from '#src/helpers/paths'
import { nannyArgv } from '#src/helpers/runtime'
import {
  HEARTBEAT_STALE_MS,
  nannyEntryPoint,
  nannySpecPath,
  nannyStatePath,
  readNannyState,
  sweepNannySpecs,
  writeNannySpec,
} from '#src/providers/nanny'
import { isPortFree, isProcessAlive, listPortHolders } from '#src/providers/port'
import { proxyEngine, proxyEngineInfos } from '#src/providers/proxy'
import { renderCaddyConfig } from '#src/services/proxy-config'

/** The engine is not a server entry, but it borrows the nanny's shape. */
const PROXY_ID = 'proxy'

const ADMIN_TIMEOUT_MS = 5000
const READY_TIMEOUT_MS = 20_000
const READY_POLL_MS = 250
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000

/** What the panel recorded when it installed the engine. */
export const engineRecordSchema = type({
  engine: 'string',
  version: 'string',
  source: '"downloaded" | "custom"',
  url: 'string',
  sha256: 'string',
  bytes: 'number',
  installedAt: 'number',
}).onUndeclaredKey('reject')
export type EngineRecord = typeof engineRecordSchema.infer

/** How the panel reaches a running engine; kept beside the nanny's state so a new panel finds it. */
const adminRecordSchema = type({
  kind: '"unix" | "tcp"',
  path: 'string = ""',
  host: 'string = ""',
  port: 'number = 0',
  origin: 'string = ""',
}).onUndeclaredKey('reject')

export interface ProxyServiceOptions {
  settings: GlobalSettingsStore
  /** The engine binary and its record. */
  binDir: string
  /** Where the engine may write; also holds the generated configuration. */
  engineDir: string
  /** Paths of the generated configuration and its previous revision. */
  configPath: string
  previousConfigPath: string
  /** The nanny's spec and state for the engine process. */
  stateDir: string
  /** Path of the admin record, so a panel that restarts can reach a running engine. */
  adminPath: string
  /** JSONL directory the nanny writes into; the panel's own `.hh/.logs`. */
  logDir: string
  /** The PEM pair `tls: "manual"` serves. */
  tls: TlsStore
  /** The live control listener, read lazily — it is created after this service. */
  control: () => ControlEndpoint
  /**
   * Resolves a supervised entry to the address the proxy should forward to.
   * `null` means the pair is unknown; a null `url` means it exists but is not up.
   */
  resolveServer: (workspaceId: string, serverId: string) => { url: string | null, message: string | null } | null
  /**
   * The exposure rule for a route that points at the panel. Injected because the
   * rule lives in `exposure.ts` and must not have a second home here.
   */
  exposureBlocked: () => string | null
  /** Called when the panel-wide state would have changed. */
  onStateChange: () => void
}

/**
 * The reverse proxy as one panel-wide service: install the engine, keep its
 * generated configuration in step with the route table, and run it under a nanny
 * so a panel restart never drops the socket that faces the internet.
 *
 * The engine's admin API is applied to, never edited by hand: `POST /load` is
 * atomic, so a configuration that does not load leaves the running one in place.
 */
export class ProxyService {
  private nanny: ChildProcess | null = null
  private admin: ProxyAdminTransport | null = null
  private lastError: string | null = null

  constructor(private readonly options: ProxyServiceOptions) {}

  get config(): ProxyConfig {
    return this.options.settings.proxy
  }

  get engine(): ProxyEngine {
    const engine = proxyEngine(this.config.engine)
    if (engine === null)
      throw new DetailedError(`unknown proxy engine "${this.config.engine}"`, { statusCode: 500, code: 'UNKNOWN_ENGINE' })
    return engine
  }

  get enginePath(): string {
    return path.join(this.options.binDir, this.engine.binaryName(process.platform))
  }

  /** The PEM pair a route with `tls: "manual"` serves; the TLS route owns its writes. */
  get manualTls(): TlsStore {
    return this.options.tls
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Called once at boot. A running engine is reattached, not restarted: unlike a
   * server entry it was never the panel's child, so it is still serving.
   */
  async initialize(): Promise<void> {
    fs.mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 })
    // A spec on disk belongs to a nanny that never read it.
    const swept = sweepNannySpecs(this.options.stateDir)
    if (swept > 0)
      logger.warn(`proxy:    removed ${swept} unread nanny spec file(s)`)
    this.admin = this.readAdmin()

    if (!this.config.enabled)
      return
    const blocked = this.options.exposureBlocked()
    if (blocked !== null) {
      // A hand-edited config can ask for something the settings write would have
      // refused; the engine simply does not start, and the panel says why.
      this.lastError = blocked
      logger.error(`proxy:    not starting — ${blocked}`)
      return
    }
    if (!this.installed()) {
      this.lastError = 'the proxy engine is not installed'
      return
    }

    if (this.live()) {
      logger.info(`proxy:    reattached to the running ${this.config.engine} engine`)
      return
    }
    try {
      await this.start()
    }
    catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      logger.error(`proxy:    could not start: ${this.lastError}`)
    }
  }

  /** True when a nanny this panel would recognise still owns the engine. */
  private live(): boolean {
    const state = readNannyState(nannyStatePath(this.options.stateDir, PROXY_ID))
    if (state === null || state.serverId !== PROXY_ID)
      return false
    return state.nannyPid > 0
      && isProcessAlive(state.nannyPid)
      && Date.now() - state.heartbeatAt <= HEARTBEAT_STALE_MS
  }

  status(): ProxyStatus {
    const config = this.config
    const base: ProxyStatus = {
      state: 'off',
      pid: null,
      urls: [],
      certExpiryDays: null,
      since: null,
      lastError: null,
    }
    if (!config.enabled)
      return base

    const urls = [`http://localhost:${config.httpPort}`, `https://localhost:${config.httpsPort}`]
    if (!this.installed()) {
      return { ...base, state: 'stopped', urls, lastError: 'the proxy engine is not installed' }
    }

    const state = readNannyState(nannyStatePath(this.options.stateDir, PROXY_ID))
    if (state === null || state.serverId !== PROXY_ID || state.nannyPid <= 0 || !isProcessAlive(state.nannyPid)) {
      const lastExit = state?.lastExit
      const detail = lastExit === undefined
        ? null
        : `the engine exited with ${lastExit.signal === null ? `code ${lastExit.code}` : `signal ${lastExit.signal}`}`
      const lastError = this.lastError ?? detail
      return { ...base, state: lastError === null ? 'stopped' : 'error', urls, lastError }
    }
    if (Date.now() - state.heartbeatAt > HEARTBEAT_STALE_MS)
      return { ...base, state: 'error', urls, pid: state.childPid, since: state.startedAt, lastError: 'the engine stopped answering (its nanny is gone)' }

    const running: ProxyRunState = this.admin === null ? 'starting' : 'running'
    return {
      ...base,
      state: running,
      pid: state.childPid ?? state.nannyPid,
      urls,
      since: state.startedAt,
      lastError: this.lastError,
    }
  }

  // --------------------------------------------------------------------- config

  /** Records why the last start or apply failed, for the frame the page reads. */
  recordError(message: string | null): void {
    this.lastError = message
    this.options.onStateChange()
  }

  update(patch: ProxyPatch): ProxyConfig {
    const config = this.options.settings.updateProxy(patch)
    this.options.onStateChange()
    return config
  }

  /** Renders the current route table and applies it; the engine keeps serving on failure. */
  async apply(): Promise<void> {
    if (!this.config.enabled || !this.installed())
      return
    if (this.admin === null) {
      const stillThere = this.readAdmin()
      if (stillThere === null)
        return
      this.admin = stillThere
    }

    const rendered = this.render()
    const text = `${JSON.stringify(rendered, null, 2)}\n`
    if (fs.existsSync(this.options.configPath)) {
      const current = fs.readFileSync(this.options.configPath, 'utf8')
      if (current === text)
        return
      writeFileAtomic(this.options.previousConfigPath, current)
    }
    writeFileAtomic(this.options.configPath, text)

    const result = await this.request('POST', '/load', rendered).catch((error: unknown) => {
      this.lastError = `the engine did not accept the configuration: ${error instanceof Error ? error.message : String(error)}`
      throw new DetailedError(this.lastError, { statusCode: 502, code: 'ENGINE_UNREACHABLE' })
    })
    if (result.status >= 400) {
      this.lastError = engineMessage(result.body) ?? `the engine rejected the configuration (HTTP ${result.status})`
      throw new DetailedError(this.lastError, { statusCode: 400, code: 'PROXY_CONFIG_REJECTED' })
    }
    this.lastError = null
    this.options.onStateChange()
  }

  /**
   * Puts the last configuration that applied back, and keeps the rejected one as
   * the new "previous" — so a revert is itself revertible.
   */
  async revert(): Promise<void> {
    if (!fs.existsSync(this.options.previousConfigPath)) {
      throw new DetailedError('there is no earlier engine configuration to go back to', { statusCode: 400, code: 'PROXY_NO_PREVIOUS' })
    }
    const current = fs.existsSync(this.options.configPath) ? fs.readFileSync(this.options.configPath, 'utf8') : null
    const previous = fs.readFileSync(this.options.previousConfigPath, 'utf8')
    writeFileAtomic(this.options.configPath, previous)
    if (current === null)
      fs.rmSync(this.options.previousConfigPath, { force: true })
    else writeFileAtomic(this.options.previousConfigPath, current)

    const result = await this.request('POST', '/load', JSON.parse(previous) as unknown)
    if (result.status >= 400) {
      this.lastError = engineMessage(result.body) ?? `the engine rejected the configuration (HTTP ${result.status})`
      throw new DetailedError(this.lastError, { statusCode: 400, code: 'PROXY_CONFIG_REJECTED' })
    }
    this.lastError = null
    this.options.onStateChange()
  }

  /** The engine configuration for the current route table, resolved upstreams included. */
  private render(): Record<string, unknown> {
    const routes = this.routeViews()
    const blocked = routes.find(view => view.status === 'error')
    if (blocked !== undefined)
      throw new DetailedError(blocked.message ?? `${blocked.route.host} cannot be routed`, { statusCode: 400, code: 'PROXY_ROUTE_INVALID' })

    const manual = this.options.tls.present && this.config.routes.some(route => route.tls === 'manual')
      ? { certificate: this.options.tls.certPath, key: this.options.tls.keyPath }
      : null

    return renderCaddyConfig({
      config: this.config,
      admin: this.admin ?? this.unixAdmin(),
      engineDir: this.options.engineDir,
      manual,
      routes: routes
        .filter(view => view.status === 'ok' && view.upstream !== null)
        .map(view => ({
          host: view.route.host,
          path: view.route.path,
          dial: view.upstream!,
          upstreamTls: view.route.target === 'panel' && this.options.control().protocol === 'https',
          tls: view.route.tls,
        })),
    })
  }

  /**
   * Every route, with the upstream resolved live. A route whose entry is stopped
   * is reported, not silently dropped: the panel says why the hostname is dark.
   */
  routeViews(): ProxyRouteView[] {
    const seen = new Map<string, string>()
    return this.config.routes.map((route) => {
      const key = `${route.host.toLowerCase()}${route.path}`
      const clash = seen.get(key)
      if (clash !== undefined) {
        return { route, status: 'error' as const, upstream: null, message: `"${route.host}" is routed twice (${clash} and ${route.id})` }
      }
      seen.set(key, route.id)

      if (!route.enabled)
        return { route, status: 'disabled' as const, upstream: null, message: null }

      if (route.target === 'external') {
        const parsed = parseUpstream(route.url)
        if (parsed === null) {
          return { route, status: 'error' as const, upstream: null, message: `"${route.id}" needs an upstream like http://10.0.0.5:8080` }
        }
        return { route, status: 'ok' as const, upstream: parsed.dial, message: null }
      }

      if (route.target === 'panel') {
        const endpoint = this.options.control()
        if (!endpoint.port)
          return { route, status: 'no-upstream' as const, upstream: null, message: 'the control panel is not listening' }
        return { route, status: 'ok' as const, upstream: `127.0.0.1:${endpoint.port}`, message: null }
      }

      if (route.workspace.length === 0 || route.server.length === 0) {
        return { route, status: 'error' as const, upstream: null, message: `"${route.id}" needs a workspace and a server` }
      }
      const resolved = this.options.resolveServer(route.workspace, route.server)
      if (resolved === null) {
        return { route, status: 'error' as const, upstream: null, message: `"${route.id}" points at ${route.workspace}/${route.server}, which does not exist` }
      }
      if (resolved.url === null) {
        return { route, status: 'no-upstream' as const, upstream: null, message: resolved.message ?? `${route.workspace}/${route.server} is not running` }
      }
      return { route, status: 'ok' as const, upstream: resolved.url.replace(/^https?:\/\//, ''), message: null }
    })
  }

  view(): ProxyView {
    return {
      config: this.config,
      engine: this.engineStatus(),
      engines: proxyEngineInfos(),
      status: this.status(),
      routes: this.routeViews(),
      tls: this.options.tls.status(this.config.routes.some(route => route.tls === 'manual')),
    }
  }

  // ---------------------------------------------------------------------- engine

  installed(): boolean {
    try {
      return fs.statSync(this.enginePath).isFile()
    }
    catch {
      return false
    }
  }

  private readEngineRecord(): EngineRecord | null {
    try {
      const parsed = engineRecordSchema(JSON.parse(fs.readFileSync(path.join(this.options.binDir, 'engine.json'), 'utf8')))
      return parsed instanceof type.errors ? null : parsed
    }
    catch {
      return null
    }
  }

  engineStatus(): ProxyEngineStatus {
    const path_ = this.enginePath
    const base: ProxyEngineStatus = {
      id: this.config.engine,
      installed: false,
      version: null,
      source: null,
      path: null,
      bytes: null,
      sha256: null,
      error: null,
    }
    let stats: fs.Stats
    try {
      stats = fs.statSync(path_)
    }
    catch {
      return base
    }
    const record = this.readEngineRecord()
    return {
      ...base,
      installed: stats.isFile(),
      version: record?.version ?? null,
      source: record?.source ?? (stats.isFile() ? 'custom' : null),
      path: path_,
      bytes: record?.bytes ?? stats.size,
      sha256: record?.sha256 ?? null,
    }
  }

  /**
   * Downloads a pinned release from the engine's own build service. Plugins are
   * compiled in server-side, so no toolchain is involved and the version is
   * whatever was asked for — never "latest" by accident.
   */
  async install(version = ''): Promise<ProxyEngineStatus> {
    const engine = this.engine
    const download = engine.download({ platform: process.platform, arch: process.arch, version })
    if (download === null) {
      throw new DetailedError(`${engine.info.label} has no build for ${process.platform}/${process.arch}`, { statusCode: 400, code: 'UNSUPPORTED_PLATFORM' })
    }

    fs.mkdirSync(this.options.binDir, { recursive: true, mode: 0o700 })
    const target = `${this.enginePath}.download`
    fs.rmSync(target, { force: true })

    const response = await fetch(download.url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok || response.body === null) {
      throw new DetailedError(`the ${engine.info.label} build service answered ${response.status}`, { statusCode: 502, code: 'ENGINE_DOWNLOAD_FAILED' })
    }

    const hash = createHash('sha256')
    const handle = fs.openSync(target, 'w', 0o755)
    let bytes = 0
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        hash.update(buffer)
        bytes += buffer.length
        fs.writeSync(handle, buffer)
      }
    }
    finally {
      fs.closeSync(handle)
    }
    if (bytes === 0) {
      fs.rmSync(target, { force: true })
      throw new DetailedError(`the ${engine.info.label} build service returned an empty binary`, { statusCode: 502, code: 'ENGINE_DOWNLOAD_FAILED' })
    }

    const sha256 = hash.digest('hex')
    if (process.platform !== 'win32')
      fs.chmodSync(target, 0o755)
    fs.renameSync(target, this.enginePath)

    const record: EngineRecord = {
      engine: engine.info.id,
      version: download.version,
      source: 'downloaded',
      url: download.url,
      sha256,
      bytes,
      installedAt: Date.now(),
    }
    writeFileAtomic(path.join(this.options.binDir, 'engine.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    logger.info(`proxy:    installed ${engine.info.label} ${download.version} (${Math.round(bytes / 1024 / 1024)} MB)`)
    this.options.onStateChange()
    return this.engineStatus()
  }

  /** Runs `version` once and reports what the binary actually is. */
  async probeEngineVersion(): Promise<string | null> {
    if (!this.installed())
      return null
    return await new Promise<string | null>((resolve) => {
      const child = spawn(this.enginePath, ['version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      let output = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
      })
      child.on('error', () => resolve(null))
      child.on('exit', () => resolve(this.engine.parseVersion(output)))
    })
  }

  // -------------------------------------------------------------------- start/stop

  async start(): Promise<void> {
    const config = this.config
    if (!config.enabled)
      throw new DetailedError('the reverse proxy is switched off', { statusCode: 400, code: 'PROXY_DISABLED' })
    const blocked = this.options.exposureBlocked()
    if (blocked !== null)
      throw new DetailedError(blocked, { statusCode: 400, code: 'PROXY_EXPOSURE_BLOCKED' })
    if (!this.installed()) {
      throw new DetailedError('the proxy engine is not installed yet', { statusCode: 400, code: 'ENGINE_MISSING' })
    }
    if (this.live()) {
      const admin = this.readAdmin()
      if (admin === null) {
        throw new DetailedError('the engine is already running but its admin endpoint is unknown — stop it first', { statusCode: 409, code: 'ENGINE_ALREADY_RUNNING' })
      }
      this.admin = admin
      await this.apply()
      return
    }

    await this.assertPortsFree(config.httpPort, config.httpsPort)

    const admin = await this.chooseAdmin()
    this.admin = admin
    const routes = this.routeViews()
    const invalid = routes.find(view => view.status === 'error')
    if (invalid !== undefined)
      throw new DetailedError(invalid.message ?? 'a route cannot be built', { statusCode: 400, code: 'PROXY_ROUTE_INVALID' })

    const manual = this.options.tls.present && config.routes.some(route => route.tls === 'manual')
      ? { certificate: this.options.tls.certPath, key: this.options.tls.keyPath }
      : null
    const rendered = renderCaddyConfig({
      config,
      admin,
      engineDir: this.options.engineDir,
      manual,
      routes: routes
        .filter(view => view.status === 'ok' && view.upstream !== null)
        .map(view => ({
          host: view.route.host,
          path: view.route.path,
          dial: view.upstream!,
          upstreamTls: view.route.target === 'panel' && this.options.control().protocol === 'https',
          tls: view.route.tls,
        })),
    })
    fs.mkdirSync(this.options.engineDir, { recursive: true, mode: 0o700 })
    writeFileAtomic(this.options.configPath, `${JSON.stringify(rendered, null, 2)}\n`)
    writeFileAtomic(this.options.adminPath, `${JSON.stringify(admin)}\n`, { mode: 0o600 })

    const specPath = nannySpecPath(this.options.stateDir, PROXY_ID)
    const statePath = nannyStatePath(this.options.stateDir, PROXY_ID)
    const env = {
      ...this.engine.env({ configPath: this.options.configPath, engineDir: this.options.engineDir, admin }),
      HHOSTED_SERVER_ID: PROXY_ID,
    }
    writeNannySpec(specPath, {
      serverId: PROXY_ID,
      command: this.enginePath,
      args: this.engine.runArgs({ configPath: this.options.configPath, engineDir: this.options.engineDir, admin }),
      cwd: this.options.engineDir,
      env,
      logDir: this.options.logDir,
      logs: { persist: true, maxBytes: 2_000_000, keep: 3 },
      // Caddy shuts down gracefully on SIGTERM; the group is not ours to signal.
      stop: { signal: 'SIGTERM', killGroup: false, graceMs: 10_000, killPortHolders: false },
    })

    this.nanny = spawn(process.execPath, nannyArgv(nannyEntryPoint(), PROXY_ID, specPath, statePath), {
      cwd: this.options.engineDir,
      env: { ...process.env, ...env, HHOSTED_HOME: dataRoot, HHOSTED_PROJECT: projectDir },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      windowsHide: true,
    })
    this.nanny.on('exit', () => {
      this.nanny = null
      this.options.onStateChange()
    })

    const ready = await this.waitReady()
    if (!ready) {
      this.lastError = `the engine did not answer on its admin endpoint within ${Math.round(READY_TIMEOUT_MS / 1000)}s: ${this.logTail()}`
      await this.stop().catch(() => undefined)
      throw new DetailedError(this.lastError, { statusCode: 502, code: 'ENGINE_NOT_READY' })
    }
    this.lastError = null
    logger.info(`proxy:    ${this.engine.info.label} serving on :${this.config.httpPort} and :${this.config.httpsPort}`)
    this.options.onStateChange()
  }

  /**
   * Stops the engine for real. The nanny holds its pipes, so the child is
   * signalled by pid first — the arrangement a persistent entry uses, and the
   * reason a stop cannot be a bare SIGKILL.
   */
  async stop(): Promise<void> {
    const statePath = nannyStatePath(this.options.stateDir, PROXY_ID)
    const state = readNannyState(statePath)

    if (state !== null && state.serverId === PROXY_ID) {
      const pids = [state.nannyPid, state.childPid].filter((pid): pid is number => pid !== null && pid > 0)
      for (const pid of pids) {
        if (!isProcessAlive(pid))
          continue
        try {
          process.kill(pid, 'SIGTERM')
        }
        catch (error) {
          logger.warn(`proxy:    could not signal pid ${pid}`, error)
        }
      }
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && pids.some(pid => isProcessAlive(pid)))
        await new Promise(resolve => setTimeout(resolve, 100))
      const survivor = pids.find(pid => isProcessAlive(pid))
      if (survivor !== undefined) {
        try {
          process.kill(survivor, 'SIGKILL')
        }
        catch {
          // Already gone between the check and the signal.
        }
      }
      fs.rmSync(statePath, { force: true })
    }

    this.nanny = null
    this.admin = null
    fs.rmSync(nannySpecPath(this.options.stateDir, PROXY_ID), { force: true })
    fs.rmSync(this.options.adminPath, { force: true })
    this.options.onStateChange()
  }

  /** The panel never owns the engine's lifetime, so a shutdown leaves it serving. */
  dispose(): void {
    if (this.nanny !== null)
      this.nanny.unref()
    this.nanny = null
  }

  private async assertPortsFree(httpPort: number, httpsPort: number): Promise<void> {
    for (const port of [httpPort, httpsPort]) {
      if (await isPortFree(port))
        continue
      const holders = await listPortHolders(port)
      const mine = readNannyState(nannyStatePath(this.options.stateDir, PROXY_ID))
      if (mine !== null && holders.length > 0 && [mine.nannyPid, mine.childPid].some(pid => pid !== null && holders.includes(pid)))
        continue
      throw new DetailedError(
        `port ${port} is already in use${holders.length > 0 ? ` (pid ${holders.join(', ')})` : ''} — stop what holds it, or set another port in the reverse proxy settings`,
        { statusCode: 409, code: 'PROXY_PORT_IN_USE', detail: { port, holders } },
      )
    }
  }

  // ----------------------------------------------------------------------- admin

  private unixAdmin(): Extract<ProxyAdminTransport, { kind: 'unix' }> {
    return { kind: 'unix', path: path.join(this.options.stateDir, 'admin.sock') }
  }

  private async chooseAdmin(): Promise<ProxyAdminTransport> {
    const unix = this.unixAdmin()
    // A unix socket path has a platform limit (about 104 bytes on macOS), and a long
    // `$HHOSTED_HOME` can cross it.
    if (process.platform !== 'win32' && Buffer.byteLength(unix.path) <= 100) {
      // A socket file left by a killed engine would stop it binding a new one.
      fs.rmSync(unix.path, { force: true })
      return unix
    }
    // No unix sockets here, so loopback TCP plus the engine's own origin check.
    for (let attempt = 0; attempt < 20; attempt++) {
      const port = 45_000 + Math.floor(Math.random() * 10_000)
      if (await isPortFree(port))
        return { kind: 'tcp', host: '127.0.0.1', port, origin: `http://127.0.0.1:${port}` }
    }
    throw new DetailedError('could not find a free loopback port for the engine admin endpoint', { statusCode: 500, code: 'PROXY_NO_ADMIN_PORT' })
  }

  private readAdmin(): ProxyAdminTransport | null {
    try {
      const parsed = adminRecordSchema(JSON.parse(fs.readFileSync(this.options.adminPath, 'utf8')))
      if (parsed instanceof type.errors)
        return null
      if (parsed.kind === 'unix')
        return parsed.path.length > 0 ? { kind: 'unix', path: parsed.path } : null
      return parsed.port > 0 ? { kind: 'tcp', host: parsed.host, port: parsed.port, origin: parsed.origin } : null
    }
    catch {
      return null
    }
  }

  private request(method: string, urlPath: string, body?: unknown): Promise<{ status: number, body: string }> {
    const admin = this.admin
    if (admin === null)
      return Promise.reject(new DetailedError('the proxy engine is not running', { statusCode: 400, code: 'ENGINE_NOT_RUNNING' }))

    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const headers: Record<string, string | number> = {}
    if (payload !== null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = payload.length
    }
    if (admin.kind === 'tcp')
      headers.origin = admin.origin

    return new Promise((resolve, reject) => {
      const request = http.request({
        ...(admin.kind === 'unix' ? { socketPath: admin.path } : { host: admin.host, port: admin.port }),
        method,
        path: urlPath,
        headers,
        timeout: ADMIN_TIMEOUT_MS,
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      })
      request.on('timeout', () => request.destroy(new Error('the engine did not answer in time')))
      request.on('error', reject)
      if (payload !== null)
        request.write(payload)
      request.end()
    })
  }

  private async waitReady(): Promise<boolean> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      try {
        const result = await this.request('GET', '/config/')
        if (result.status < 400)
          return true
      }
      catch {
        // Not up yet, or not there at all.
      }
      await new Promise(resolve => setTimeout(resolve, READY_POLL_MS))
    }
    return false
  }

  /** The last few engine lines, for a start that failed. */
  private logTail(): string {
    try {
      const file = path.join(this.options.logDir, `${PROXY_ID}.log`)
      const text = fs.readFileSync(file, 'utf8')
      const lines = text.trimEnd().split('\n').slice(-3)
      return lines.map((line) => {
        try {
          const parsed = JSON.parse(line) as { text?: string }
          return parsed.text ?? line
        }
        catch {
          return line
        }
      }).join(' | ')
    }
    catch {
      return 'no engine output yet'
    }
  }
}

/** `host:port`, `http://host:port` or `https://host:port`; `null` when unusable. */
export function parseUpstream(value: string): { dial: string, tls: boolean } | null {
  const trimmed = value.trim()
  if (trimmed.length === 0)
    return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.port.length === 0)
      return null
    return { dial: `${url.hostname}:${url.port}`, tls: url.protocol === 'https:' }
  }
  catch {
    return null
  }
}

/** Cross-field problems ArkType cannot see, reported by the API before a save. */
export function validateProxyConfig(config: ProxyConfig): string[] {
  const errors: string[] = []
  if (config.httpPort === config.httpsPort)
    errors.push('the http and https ports must differ')

  const advertised = new Set(config.routes.filter(route => route.tls !== 'off').map(route => route.host.toLowerCase()))
  const publicNames = [...advertised].filter(host => isPublicHost(host))
  if (publicNames.length > 0 && config.email.trim().length === 0 && !config.staging)
    errors.push(`automatic HTTPS needs an ACME account e-mail for ${publicNames.join(', ')}`)

  const seen = new Set<string>()
  const ids = new Set<string>()
  for (const route of config.routes) {
    if (ids.has(route.id))
      errors.push(`route id "${route.id}" is used twice`)
    ids.add(route.id)

    const key = `${route.host.toLowerCase()}${route.path}`
    if (seen.has(key))
      errors.push(`"${route.host}" is routed twice`)
    seen.add(key)

    if (route.target === 'server' && (route.workspace.length === 0 || route.server.length === 0))
      errors.push(`route "${route.id}" needs a workspace and a server`)
    if (route.target === 'external' && parseUpstream(route.url) === null)
      errors.push(`route "${route.id}" needs an upstream like http://10.0.0.5:8080`)
  }
  return errors
}

/**
 * A name an ACME CA could issue for. A local-only name gets the engine's own CA
 * instead, so it never needs an account address — requiring one would block the
 * LAN-only setup that has no public DNS at all. The list is the reserved and
 * homelab TLDs a public CA cannot serve.
 */
const LOCAL_TLDS = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.home', '.test', '.invalid', '.example']

export function isPublicHost(host: string): boolean {
  const name = host.toLowerCase()
  if (name === 'localhost' || !name.includes('.'))
    return false
  if (LOCAL_TLDS.some(tld => name.endsWith(tld)))
    return false
  return !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(name)
}

/** Caddy answers with `{"error": "..."}`; that sentence is the useful part. */
function engineMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    return typeof parsed.error === 'string' && parsed.error.length > 0 ? parsed.error : null
  }
  catch {
    return body.trim().length > 0 ? body.trim().slice(0, 400) : null
  }
}
