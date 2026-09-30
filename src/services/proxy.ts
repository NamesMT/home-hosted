import type { ChildProcess } from 'node:child_process'
import type { GlobalSettingsStore } from '#src/config/settings'
import type { ProxyAdminTransport, ProxyEngine } from '#src/providers/proxy'
import type { ControlEndpoint } from '#src/services/control-server'
import type { ProxyUpstreamRoute } from '#src/services/proxy-config'
import type {
  ProxyCertificateState,
  ProxyCertificateView,
  ProxyConfig,
  ProxyEngineStatus,
  ProxyPatch,
  ProxyRoute,
  ProxyRouteStatus,
  ProxyRouteView,
  ProxyRunState,
  ProxyStatus,
  ProxyView,
} from '#src/shared/contracts'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
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
import { TlsStore } from '#src/services/tls'

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

/** The DNS names a certificate covers, from its SANs (and its subject as a fallback). */
function namesOf(x509: X509Certificate): string[] {
  const names = new Set<string>()
  for (const part of (x509.subjectAltName ?? '').split(',')) {
    const trimmed = part.trim()
    if (!trimmed.toUpperCase().startsWith('DNS:'))
      continue
    const value = trimmed.slice(4).trim().toLowerCase()
    if (value.length > 0)
      names.add(value)
  }
  if (names.size === 0) {
    const cn = /CN=([^,\n]+)/.exec(x509.subject)?.[1]?.trim()
    if (cn !== undefined && cn.length > 0)
      names.add(cn.toLowerCase())
  }
  return [...names]
}

/** True when a pair covers this hostname, wildcards included. */
function coversHost(hosts: readonly string[], host: string): boolean {
  const name = host.toLowerCase()
  return hosts.some((entry) => {
    if (entry === name)
      return true
    if (!entry.startsWith('*.'))
      return false
    const suffix = entry.slice(1)
    return name.endsWith(suffix) && !name.slice(0, -suffix.length).includes('.')
  })
}

/** One route resolved far enough for the engine (and the UI) to use it. */
interface ResolvedRoute {
  route: ProxyRoute
  status: ProxyRouteStatus
  upstream: string | null
  /** The upstream speaks TLS, so the engine must not dial it in cleartext. */
  upstreamTls: boolean
  message: string | null
}

/** The ports the engine actually bound, so a rejected reload cannot make the panel lie. */
const appliedRecordSchema = type({
  httpPort: '1 <= number.integer <= 65535',
  httpsPort: '1 <= number.integer <= 65535',
  at: 'number',
}).onUndeclaredKey('reject')

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
  /** Where the uploaded PEM pairs live, one `<id>.crt.pem`/`<id>.key.pem` per entry. */
  tlsDir: string
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
  private certCache: { at: number, key: string, days: number | null, issued: Map<string, { notAfter: number, issuer: string }>, views: ProxyCertificateView[] } | null = null
  /** The certificate state the last apply was built from, so a change re-applies once. */
  private certificateSignature: string | null = null

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

  /** One uploaded pair, by the id that names it in the config. */
  private pairStore(id: string): TlsStore {
    return new TlsStore(this.options.tlsDir, id)
  }

  /**
   * Stores a pair under `id` and records it in the config, so a route can be
   * checked against what it actually covers.
   */
  saveCertificate(id: string, label: string, certificate: string, privateKey: string): { ok: boolean, error?: string } {
    const saved = this.pairStore(id).save(certificate, privateKey)
    if (!saved.ok)
      return saved

    const certificates = this.config.certificates.some(entry => entry.id === id)
      ? this.config.certificates.map(entry => (entry.id === id ? { ...entry, label } : entry))
      : [...this.config.certificates, { id, label }]
    this.options.settings.updateProxy({ certificates })
    this.certCache = null
    this.certificateSignature = null
    this.options.onStateChange()
    return { ok: true }
  }

  /**
   * Removes a pair — refused while a route still serves it, because deleting the
   * files first would leave the engine on a certificate the panel has dropped.
   */
  clearCertificate(id: string): void {
    const pair = this.certificateViews().find(entry => entry.id === id)
    const holders = this.config.routes.filter(route => route.tls === 'manual' && pair !== undefined && coversHost(pair.hosts, route.host))
    if (holders.length > 0) {
      throw new DetailedError(
        `that certificate is still served by ${holders.map(route => `"${route.id}"`).join(', ')} — set those routes to another TLS mode first`,
        { statusCode: 400, code: 'PROXY_TLS_IN_USE', detail: { routes: holders.map(route => route.id) } },
      )
    }
    this.pairStore(id).clear()
    this.options.settings.updateProxy({ certificates: this.config.certificates.filter(entry => entry.id !== id) })
    this.certCache = null
    this.certificateSignature = null
    this.options.onStateChange()
  }

  /** Every uploaded pair, described: what it is for, and what it covers. */
  certificateViews(): ProxyCertificateView[] {
    return this.certSnapshot().views
  }

  /**
   * What the certificate snapshot depends on: the config it resolves against, and the
   * uploaded pair files themselves. Keying on both means a route edit, an upload, or a
   * pair that expired (or was replaced) on disk is reflected on the next read, while a
   * steady state still costs one read per 15 seconds.
   */
  private certKey(): string {
    const config = [
      ...this.config.certificates.map(entry => `${entry.id}:${entry.label}`),
      ...this.config.routes.map(route => `${route.id}:${route.host}:${route.tls}:${route.enabled}`),
    ].join('|')
    const files = this.config.certificates.map((entry) => {
      const store = this.pairStore(entry.id)
      const stamp = (file: string): string => {
        try {
          const stats = fs.statSync(file)
          return `${stats.mtimeMs}:${stats.size}`
        }
        catch {
          return 'x'
        }
      }
      return `${entry.id}:${stamp(store.certPath)}:${stamp(store.keyPath)}`
    }).join('|')
    return `${config}#${files}`
  }

  /** The certificate store read once, so a per-second tick costs nothing. */
  private certSnapshot(): { at: number, key: string, days: number | null, issued: Map<string, { notAfter: number, issuer: string }>, views: ProxyCertificateView[] } {
    const key = this.certKey()
    if (this.certCache !== null && this.certCache.key === key && Date.now() - this.certCache.at < 15_000)
      return this.certCache
    const views = this.readCertificateViews()
    const issued = this.readIssuedCertificates()
    const values = [...issued.values()]
    const soonest = values.length === 0 ? null : Math.min(...values.map(entry => entry.notAfter))
    this.certCache = {
      at: Date.now(),
      key,
      days: soonest === null ? null : Math.floor((soonest - Date.now()) / 86_400_000),
      issued,
      views,
    }
    return this.certCache
  }

  /**
   * The pair that would actually serve this hostname: an exact SAN beats a wildcard,
   * and an expired or unreadable pair is not a candidate at all.
   */
  private bestCover(host: string): ProxyCertificateView | null {
    const usable = this.certificateViews().filter(entry => entry.present && entry.error === null)
    const name = host.toLowerCase()
    return usable.find(entry => entry.hosts.includes(name))
      ?? usable.find(entry => coversHost(entry.hosts, name))
      ?? null
  }

  private readCertificateViews(): ProxyCertificateView[] {
    const views = this.config.certificates.map((entry) => {
      const store = this.pairStore(entry.id)
      const base: ProxyCertificateView = {
        id: entry.id,
        label: entry.label,
        present: store.present,
        used: false,
        subject: null,
        issuer: null,
        validTo: null,
        daysRemaining: null,
        hosts: [],
        error: store.present ? null : 'the pair is not on disk',
      }
      const pair = store.load()
      if (pair === null)
        return base
      try {
        const x509 = new X509Certificate(pair.cert)
        const validTo = new Date(x509.validTo)
        return {
          ...base,
          subject: x509.subject.replace(/\n/g, ', '),
          issuer: x509.issuer.replace(/\n/g, ', '),
          validTo: validTo.toISOString(),
          daysRemaining: Math.floor((validTo.getTime() - Date.now()) / 86_400_000),
          hosts: namesOf(x509),
          error: store.status(true).error,
        }
      }
      catch (error) {
        return { ...base, error: `unreadable certificate: ${error instanceof Error ? error.message : String(error)}` }
      }
    })

    // Two pairs can cover one name (a wildcard and an exact one, or two copies of the
    // same thing); the engine serves one, so say which. A pair no route would get is
    // reported as unused rather than healthy.
    const wanted = new Set<string>()
    for (const route of this.config.routes.filter(entry => entry.tls === 'manual')) {
      const name = route.host.toLowerCase()
      const usable = views.filter(entry => entry.present && entry.error === null)
      const best = usable.find(entry => entry.hosts.includes(name)) ?? usable.find(entry => coversHost(entry.hosts, name))
      if (best !== undefined)
        wanted.add(best.id)
    }
    return views.map(entry => ({ ...entry, used: wanted.has(entry.id) }))
  }

  /**
   * What a route's certificate situation is: read from the engine's own store for a
   * managed name, and from the last thing the engine said about it in its log.
   */
  private certificateFor(route: ProxyRoute): { state: ProxyCertificateState, message: string | null } {
    if (route.tls === 'off')
      return { state: 'off', message: null }

    if (route.tls === 'manual') {
      const best = this.bestCover(route.host)
      if (best !== null)
        return { state: 'uploaded', message: best.label.length > 0 ? best.label : best.id }

      // A pair that covers the name but cannot be used says why — an expired one is the
      // case that would otherwise be served happily.
      const covering = this.certificateViews().find(entry => entry.present && coversHost(entry.hosts, route.host))
      return {
        state: 'failed',
        message: covering === undefined
          ? `no uploaded certificate covers ${route.host}`
          : `${covering.error ?? 'the uploaded certificate cannot be used'} — upload a valid pair for ${route.host}`,
      }
    }

    if (!isPublicHost(route.host))
      return { state: 'local', message: 'signed by the engine\'s own CA' }

    const issued = this.issuedCertificates().get(route.host.toLowerCase())
    if (issued !== undefined)
      return { state: 'issued', message: `expires in ${Math.floor((issued.notAfter - Date.now()) / 86_400_000)} days` }

    const failure = this.obtainFailures().get(route.host.toLowerCase())
    return failure === undefined
      ? { state: 'pending', message: 'the engine is waiting for a certificate' }
      : { state: 'failed', message: failure }
  }

  /** Managed certificates the engine holds, by hostname. */
  private issuedCertificates(): Map<string, { notAfter: number, issuer: string }> {
    return this.certSnapshot().issued
  }

  private readIssuedCertificates(): Map<string, { notAfter: number, issuer: string }> {
    const found = new Map<string, { notAfter: number, issuer: string }>()
    const root = path.join(this.options.engineDir, 'data', 'certificates')
    const walk = (dir: string, inside: boolean): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      }
      catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          // The engine's own CA renews constantly; only public issuance is reported.
          if (!inside && entry.name === 'local')
            continue
          walk(full, true)
          continue
        }
        if (!entry.name.endsWith('.crt'))
          continue
        try {
          const x509 = new X509Certificate(fs.readFileSync(full))
          const info = { notAfter: new Date(x509.validTo).getTime(), issuer: x509.issuer.replace(/\n/g, ', ') }
          for (const host of namesOf(x509)) {
            const known = found.get(host)
            if (known === undefined || info.notAfter < known.notAfter)
              found.set(host, info)
          }
        }
        catch {
          // Not a PEM we can read; it is not evidence about any certificate.
        }
      }
    }
    walk(root, false)
    return found
  }

  /**
   * The last thing the engine said about obtaining a certificate, per name. Caddy
   * has no admin endpoint that lists failures, so its own log is the source.
   */
  private obtainFailures(): Map<string, string> {
    const failures = new Map<string, string>()
    let text: string
    try {
      text = fs.readFileSync(path.join(this.options.logDir, `${PROXY_ID}.log`), 'utf8')
    }
    catch {
      return failures
    }

    for (const line of text.trimEnd().split('\n').slice(-400)) {
      let inner: Record<string, unknown>
      try {
        const outer = JSON.parse(line) as { text?: string }
        inner = JSON.parse(outer.text ?? '') as Record<string, unknown>
      }
      catch {
        continue
      }
      const identifier = typeof inner.identifier === 'string' ? inner.identifier.toLowerCase() : null
      if (identifier === null)
        continue
      if (inner.logger === 'tls.obtain' && typeof inner.error === 'string')
        failures.set(identifier, inner.error)
      // A later success clears it, so a name that recovered is not reported failed.
      if (inner.msg === 'certificate obtained successfully')
        failures.delete(identifier)
    }
    return failures
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
      // A reattached engine still holds the configuration from before this panel
      // started — after an upgrade that is the old shape. Applying is a no-op when
      // nothing changed.
      await this.apply().catch((error: unknown) => {
        logger.warn(`proxy:    could not apply the current configuration to the reattached engine: ${error instanceof Error ? error.message : String(error)}`)
      })
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

    // The ports the engine bound, not the ones the settings now ask for: a reload
    // the engine rejected leaves it serving on what it already had.
    const applied = this.readApplied()
    const httpPort = applied?.httpPort ?? config.httpPort
    const httpsPort = applied?.httpsPort ?? config.httpsPort
    const urls = [`http://localhost:${httpPort}`, `https://localhost:${httpsPort}`]
    const certExpiryDays = this.certificateExpiryDays()
    if (!this.installed())
      return { ...base, state: 'stopped', urls, certExpiryDays, lastError: 'the proxy engine is not installed' }

    const state = readNannyState(nannyStatePath(this.options.stateDir, PROXY_ID))
    if (state === null || state.serverId !== PROXY_ID || state.nannyPid <= 0 || !isProcessAlive(state.nannyPid)) {
      const lastExit = state?.lastExit
      const detail = lastExit === undefined
        ? null
        : `the engine exited with ${lastExit.signal === null ? `code ${lastExit.code}` : `signal ${lastExit.signal}`}`
      const lastError = this.lastError ?? detail
      return { ...base, state: lastError === null ? 'stopped' : 'error', urls, certExpiryDays, lastError }
    }
    if (Date.now() - state.heartbeatAt > HEARTBEAT_STALE_MS)
      return { ...base, state: 'error', urls, certExpiryDays, pid: state.childPid, since: state.startedAt, lastError: 'the engine stopped answering (its nanny is gone)' }

    const identity = { pid: state.childPid ?? state.nannyPid, since: state.startedAt, certExpiryDays }
    if (this.admin === null)
      return { ...base, state: 'starting', urls, ...identity, lastError: this.lastError }
    // A nanny that outlived its child leaves a state file behind for a moment; the
    // admin endpoint is the thing we would actually talk to.
    if (this.admin.kind === 'unix' && !fs.existsSync(this.admin.path))
      return { ...base, state: 'error', urls, ...identity, lastError: this.lastError ?? 'the engine is not answering on its admin endpoint' }

    return { ...base, state: 'running' as ProxyRunState, urls, ...identity, lastError: this.lastError }
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
    if (fs.existsSync(this.options.configPath) && fs.readFileSync(this.options.configPath, 'utf8') === text) {
      this.lastError = null
      return
    }

    // The engine cannot bind a port a stranger holds, and the raw error it answers
    // with names no process. Ask first, so the answer names the pid to stop.
    await this.assertPortsFree(this.config.httpPort, this.config.httpsPort)

    const result = await this.request('POST', '/load', rendered).catch((error: unknown) => {
      this.lastError = `the engine did not accept the configuration: ${error instanceof Error ? error.message : String(error)}`
      throw new DetailedError(this.lastError, { statusCode: 502, code: 'ENGINE_UNREACHABLE' })
    })
    if (result.status >= 400) {
      this.lastError = engineMessage(result.body) ?? `the engine rejected the configuration (HTTP ${result.status})`
      throw new DetailedError(this.lastError, { statusCode: 400, code: 'PROXY_CONFIG_REJECTED' })
    }

    // Only now is this the configuration: the file the engine boots from must never
    // hold a revision it refused.
    this.rememberConfig(text)
    this.rememberApplied(this.config.httpPort, this.config.httpsPort)
    this.lastError = null
    this.options.onStateChange()
  }

  /** Advances `previous.json` only for a configuration the engine accepted. */
  private rememberConfig(text: string): void {
    if (fs.existsSync(this.options.configPath))
      writeFileAtomic(this.options.previousConfigPath, fs.readFileSync(this.options.configPath, 'utf8'))
    writeFileAtomic(this.options.configPath, text)
  }

  /** The ports the engine last bound. */
  private readApplied(): { httpPort: number, httpsPort: number } | null {
    try {
      const parsed = appliedRecordSchema(JSON.parse(fs.readFileSync(path.join(this.options.stateDir, 'applied.json'), 'utf8')))
      return parsed instanceof type.errors ? null : { httpPort: parsed.httpPort, httpsPort: parsed.httpsPort }
    }
    catch {
      return null
    }
  }

  private rememberApplied(httpPort: number, httpsPort: number): void {
    writeFileAtomic(path.join(this.options.stateDir, 'applied.json'), `${JSON.stringify({ httpPort, httpsPort, at: Date.now() })}\n`, { mode: 0o600 })
  }

  /**
   * Days until the soonest publicly-issued certificate expires. The engine's own CA
   * is left out on purpose: it re-issues constantly, so its leaves are always hours
   * from expiry and would read as a problem.
   */
  private certificateExpiryDays(): number | null {
    return this.certSnapshot().days
  }

  /** True when an uploaded pair covers this hostname. */
  private manualCovers(host: string): boolean {
    return this.bestCover(host) !== null
  }

  /**
   * Re-applies the configuration when the certificate situation changed — a name that
   * just obtained its certificate stops being served the "not ready" page, and one
   * that lost it starts. Cheap enough for the panel's tick: the store read is cached.
   */
  async sync(): Promise<void> {
    if (!this.config.enabled || !this.installed())
      return
    if (this.status().state !== 'running')
      return
    const signature = this.routeViews().map(view => `${view.route.id}:${view.certificate?.state ?? ''}`).join('|')
    if (signature === this.certificateSignature)
      return
    const first = this.certificateSignature === null
    this.certificateSignature = signature
    if (first)
      return
    await this.apply().catch((error: unknown) => {
      logger.warn(`proxy:    could not re-apply after a certificate change: ${error instanceof Error ? error.message : String(error)}`)
    })
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

    const result = await this.request('POST', '/load', JSON.parse(previous) as unknown)
    if (result.status >= 400) {
      this.lastError = engineMessage(result.body) ?? `the engine rejected the configuration (HTTP ${result.status})`
      throw new DetailedError(this.lastError, { statusCode: 400, code: 'PROXY_CONFIG_REJECTED' })
    }

    writeFileAtomic(this.options.configPath, previous)
    if (current === null)
      fs.rmSync(this.options.previousConfigPath, { force: true })
    else writeFileAtomic(this.options.previousConfigPath, current)
    this.lastError = null
    this.options.onStateChange()
  }

  /**
   * The engine configuration for the current route table. Throws when a route cannot
   * be built, because a half-built configuration is worse than a refused one.
   */
  private render(): Record<string, unknown> {
    const blocked = this.resolveRoutes().find(view => view.status === 'error')
    if (blocked !== undefined)
      throw new DetailedError(blocked.message ?? `${blocked.route.host} cannot be routed`, { statusCode: 400, code: 'PROXY_ROUTE_INVALID' })

    const routes = this.engineRoutes()
    return renderCaddyConfig({
      config: this.config,
      admin: this.admin ?? this.unixAdmin(),
      engineDir: this.options.engineDir,
      manual: this.manualPairs(),
      acme: this.acmeAccount(routes),
      routes,
    })
  }

  /** The uploaded pairs, when any route actually asks for one. */
  private manualPairs(): Array<{ certificate: string, key: string }> {
    if (!this.config.routes.some(route => route.tls === 'manual'))
      return []
    return this.certificateViews()
      .filter(entry => entry.present && entry.error === null)
      .map(entry => this.pairStore(entry.id))
      .map(store => ({ certificate: store.certPath, key: store.keyPath }))
  }

  /** The ACME account, and the names it may issue for: only the public ones. */
  private acmeAccount(routes: readonly ProxyUpstreamRoute[]): { email: string, staging: boolean, subjects: string[] } {
    return {
      email: this.config.email.trim(),
      staging: this.config.staging,
      subjects: routes.filter(route => route.tls === 'auto' && isPublicHost(route.host)).map(route => route.host),
    }
  }

  /** Every route, resolved far enough to render. */
  private resolveRoutes(): ResolvedRoute[] {
    const seen = new Map<string, string>()
    return this.config.routes.map((route): ResolvedRoute => {
      const key = `${route.host.toLowerCase()}${route.path}`
      const clash = seen.get(key)
      if (clash !== undefined)
        return { route, status: 'error', upstream: null, upstreamTls: false, message: `"${route.host}" is routed twice (${clash} and ${route.id})` }
      seen.set(key, route.id)

      if (!route.enabled)
        return { route, status: 'disabled', upstream: null, upstreamTls: false, message: null }

      // `manual` means the uploaded pair and nothing else: without one the engine
      // would quietly obtain its own certificate for a name the user marked manual.
      if (route.tls === 'manual' && !this.manualCovers(route.host)) {
        const reason = this.certificateFor(route).message ?? `no uploaded certificate covers ${route.host}`
        return { route, status: 'error', upstream: null, upstreamTls: false, message: `"${route.id}" ${reason}` }
      }

      if (route.target === 'external') {
        const parsed = parseUpstream(route.url)
        if (parsed === null)
          return { route, status: 'error', upstream: null, upstreamTls: false, message: `"${route.id}" needs an upstream like http://10.0.0.5:8080` }
        return { route, status: 'ok', upstream: parsed.dial, upstreamTls: parsed.tls, message: null }
      }

      if (route.target === 'panel') {
        const endpoint = this.options.control()
        if (!endpoint.port)
          return { route, status: 'no-upstream', upstream: null, upstreamTls: false, message: 'the control panel is not listening' }
        return { route, status: 'ok', upstream: `127.0.0.1:${endpoint.port}`, upstreamTls: endpoint.protocol === 'https', message: null }
      }

      if (route.workspace.length === 0 || route.server.length === 0)
        return { route, status: 'error', upstream: null, upstreamTls: false, message: `"${route.id}" needs a workspace and a server` }

      const resolved = this.options.resolveServer(route.workspace, route.server)
      if (resolved === null)
        return { route, status: 'error', upstream: null, upstreamTls: false, message: `"${route.id}" points at ${route.workspace}/${route.server}, which does not exist` }
      if (resolved.url === null)
        return { route, status: 'no-upstream', upstream: null, upstreamTls: false, message: resolved.message ?? `${route.workspace}/${route.server} is not running` }
      return { route, status: 'ok', upstream: resolved.url.replace(/^https?:\/\//, ''), upstreamTls: resolved.url.startsWith('https://'), message: null }
    })
  }

  /** Only the routes the engine can serve, in the shape the renderer wants. */
  private engineRoutes(): ProxyUpstreamRoute[] {
    return this.resolveRoutes()
      .filter(resolved => resolved.status === 'ok' && resolved.upstream !== null)
      .map((resolved) => {
        const certificate = this.certificateFor(resolved.route)
        return {
          host: resolved.route.host,
          path: resolved.route.path,
          dial: resolved.upstream!,
          upstreamTls: resolved.upstreamTls,
          tls: resolved.route.tls,
          // A name whose certificate is not there yet gets a rendered page on the
          // cleartext side instead of a redirect into a handshake that cannot finish.
          certificateReady: certificate.state === 'issued' || certificate.state === 'local' || certificate.state === 'uploaded',
        }
      })
  }

  /**
   * Every route, with the upstream resolved live. A route whose entry is stopped
   * is reported, not silently dropped: the panel says why the hostname is dark.
   */
  routeViews(): ProxyRouteView[] {
    return this.resolveRoutes().map(({ route, status, upstream, message }) => ({
      route,
      status,
      upstream,
      message,
      certificate: this.certificateFor(route),
    }))
  }

  view(): ProxyView {
    return {
      config: this.config,
      engine: this.engineStatus(),
      engines: proxyEngineInfos(),
      status: this.status(),
      routes: this.routeViews(),
      certificates: this.certificateViews(),
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
    if (version.length > 0 && !/^v?\d+\.\d+\.\d[\w.+-]*$/.test(version)) {
      throw new DetailedError(`"${version}" is not a ${engine.info.label} version`, { statusCode: 400, code: 'INVALID_ENGINE_VERSION' })
    }
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

    if (process.platform !== 'win32')
      fs.chmodSync(this.enginePath, 0o755)

    // What the binary says it is, not what was asked for: the build service answers
    // a request for a version it does not have with its default release.
    const probed = await this.probeEngineVersion()
    const record: EngineRecord = {
      engine: engine.info.id,
      version: probed ?? download.version,
      source: 'downloaded',
      url: download.url,
      sha256,
      bytes,
      installedAt: Date.now(),
    }
    writeFileAtomic(path.join(this.options.binDir, 'engine.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    logger.info(`proxy:    installed ${engine.info.label} ${record.version} (${Math.round(bytes / 1024 / 1024)} MB)`)
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
    const invalid = this.resolveRoutes().find(view => view.status === 'error')
    if (invalid !== undefined)
      throw new DetailedError(invalid.message ?? 'a route cannot be built', { statusCode: 400, code: 'PROXY_ROUTE_INVALID' })

    const routes = this.engineRoutes()
    const rendered = renderCaddyConfig({
      config,
      admin,
      engineDir: this.options.engineDir,
      manual: this.manualPairs(),
      acme: this.acmeAccount(routes),
      routes,
    })
    fs.mkdirSync(this.options.engineDir, { recursive: true, mode: 0o700 })
    this.rememberConfig(`${JSON.stringify(rendered, null, 2)}\n`)
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
      // The handle is gone, so nothing it owned is ours to talk to any more — a
      // stale admin.json would have the next apply() reach for a dead socket.
      this.admin = null
      fs.rmSync(this.options.adminPath, { force: true })
      this.options.onStateChange()
    })

    const ready = await this.waitReady()
    if (!ready) {
      this.lastError = `the engine did not answer on its admin endpoint within ${Math.round(READY_TIMEOUT_MS / 1000)}s: ${this.logTail()}`
      await this.stop().catch(() => undefined)
      throw new DetailedError(this.lastError, { statusCode: 502, code: 'ENGINE_NOT_READY' })
    }
    this.rememberApplied(config.httpPort, config.httpsPort)
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
    this.certCache = null
    this.certificateSignature = null
    fs.rmSync(nannySpecPath(this.options.stateDir, PROXY_ID), { force: true })
    fs.rmSync(this.options.adminPath, { force: true })
    fs.rmSync(path.join(this.options.stateDir, 'applied.json'), { force: true })
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
