import type { ChildProcess } from 'node:child_process'
import type { GlobalSettingsStore } from '#src/config/settings'
import type { ProxyAdminTransport, ProxyEngine } from '#src/providers/proxy'
import type { ChallengeAccount } from '#src/services/acme-challenge'
import type { ControlEndpoint } from '#src/services/control-server'
import type { ProxyConfigInput, ProxyUpstreamRoute } from '#src/services/proxy-config'
import type {
  ProxyCertificateState,
  ProxyCertificateView,
  ProxyConfig,
  ProxyDnsAccountView,
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
import { randomBytes, X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { writeFileAtomic } from '#src/helpers/atomic'
import { logger } from '#src/helpers/logger'
import { dataRoot, projectDir, proxyChallengeAuthPath } from '#src/helpers/paths'
import { nannyArgv } from '#src/helpers/runtime'
import { ddnsProvider } from '#src/providers/ddns'
import { normalizeHost } from '#src/providers/ddns/types'
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
import { FALLBACK_NAME, renderCaddyConfig } from '#src/services/proxy-config'
import { TlsStore } from '#src/services/tls'

/** The engine is not a server entry, but it borrows the nanny's shape. */
const PROXY_ID = 'proxy'

const ADMIN_TIMEOUT_MS = 5000
const READY_TIMEOUT_MS = 20_000
const READY_POLL_MS = 250
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000

/** How long the binary gets to answer `version` or `list-modules` before it is killed. */
const ENGINE_COMMAND_TIMEOUT_MS = 10_000

/** The module the panel's DNS-01 configuration names; the engine must carry it. */
const DNS01_MODULE = 'dns.providers.acmeproxy'

/**
 * What the panel recorded when it installed the engine. The binary itself is not
 * the panel's to vouch for: a checksum of what was downloaded is recorded nowhere,
 * because replacing the binary by hand is a supported way to run a custom build.
 */
export const engineRecordSchema = type({
  engine: 'string',
  version: 'string',
  source: '"downloaded" | "custom"',
  url: 'string',
  bytes: 'number',
  installedAt: 'number',
}).onUndeclaredKey('reject')
export type EngineRecord = typeof engineRecordSchema.infer

/**
 * The Basic credentials the engine uses to reach the panel's DNS-01 endpoint.
 * Generated once and kept beside the engine's other state, 0600 — the endpoint is
 * loopback-only, and this is the second lock on a door that writes into DNS.
 */
export const challengeAuthSchema = type({
  username: 'string >= 1',
  password: 'string >= 1',
}).onUndeclaredKey('reject')
export type ChallengeAuth = typeof challengeAuthSchema.infer

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
  /** How long `version`/`list-modules` may take; overridden in tests. */
  engineCommandTimeoutMs?: number
  /** Where the engine's DNS-01 credentials live, 0600. */
  challengeAuthPath?: string
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
  /** Test seams: the lifecycle steps that wait on a real engine. */
  waitReady?: () => Promise<boolean>
  chooseAdmin?: () => Promise<ProxyAdminTransport>
  /**
   * The DNS account a hostname's DNS-01 challenge is written through, by
   * `<workspace>/<account>`. `null` means no account claims the name, so the
   * challenge is refused rather than guessed at.
   */
  resolveDnsAccount?: (workspaceId: string, accountId: string) => { provider: string, credentials: Record<string, string> | null } | null
  /**
   * Every account a route may name, for the page's picker. Flattened here so the
   * page reads one list instead of walking every workspace itself.
   */
  listDnsAccounts?: () => ProxyDnsAccountView[]
  /** The workspace a route belongs to, when it does not name one itself. */
  defaultWorkspaceId?: () => string
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
  /** The installed binary's modules, read once per process; an install clears it. */
  private moduleCache: Set<string> | null = null
  /** A legacy `engine.json` is reported once, not on every state frame. */
  private legacyChecksumWarned = false
  /** Why the engine's nanny could not be spawned, cleared on the next start. */
  private nannyError: string | null = null
  private certCache: { at: number, key: string, days: number | null, issued: Map<string, { notAfter: number, issuer: string }>, local: Map<string, { notAfter: number, lifetimeMs: number }>, views: ProxyCertificateView[] } | null = null
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

  /**
   * The Basic credentials the engine uses to reach the panel's DNS-01 endpoint.
   * Generated on first use and kept 0600: the endpoint is loopback-only, and this
   * is the second lock on a door that writes into somebody's DNS.
   */
  challengeAuth(): ChallengeAuth {
    const file = this.options.challengeAuthPath ?? proxyChallengeAuthPath
    try {
      const parsed = challengeAuthSchema(JSON.parse(fs.readFileSync(file, 'utf8')))
      if (!(parsed instanceof type.errors))
        return parsed
    }
    catch {
      // Absent or unreadable: a fresh pair below is the answer either way.
    }
    const auth: ChallengeAuth = {
      username: 'hh',
      password: randomBytes(24).toString('base64url'),
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    writeFileAtomic(file, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 })
    return auth
  }

  /**
   * The DNS-01 half of the renderer's input, or undefined when it is switched off.
   *
   * One entry per account, because an engine policy carries one challenge provider:
   * a name whose zone is at Cloudflare and one at deSEC need a policy each.
   */
  private dns01Input(routes: readonly ProxyUpstreamRoute[]): ProxyConfigInput['dns01'] {
    if (!this.config.dns01.enabled)
      return undefined
    const endpoint = this.options.control()
    const auth = this.challengeAuth()

    // The hostnames the engine would ask a challenge for, grouped by the account
    // that answers each one.
    const policies = groupDns01Policies(routes, host => this.resolveAccount(host))

    return {
      resolvers: this.config.dns01.resolvers,
      // The engine dials the panel on loopback, whatever the panel binds for people.
      endpoint: `${endpoint.protocol}://127.0.0.1:${endpoint.port}/_acme`,
      username: auth.username,
      password: auth.password,
      policies,
    }
  }

  /** The workspace a route's DNS account is looked up in. */
  private workspaceOf(route: ProxyRoute): string {
    if (route.workspace.length > 0)
      return route.workspace
    return this.options.defaultWorkspaceId?.() ?? ''
  }

  /**
   * The account a route names, or null when it names none.
   *
   * A bare id belongs to the route's own workspace; `<workspace>/<id>` crosses into
   * another one, which is what lets one route table cover zones owned by different
   * workspaces.
   */
  private dnsAccountRef(route: ProxyRoute | undefined): { owner: string, accountId: string, provider: string } | null {
    if (route === undefined)
      return null
    const named = route.dnsAccount.trim()
    if (named.length === 0)
      return null
    const workspaceId = this.workspaceOf(route)
    if (workspaceId.length === 0)
      return null
    const [owner, accountId] = named.includes('/') ? named.split('/', 2) : [workspaceId, named]
    const resolved = this.options.resolveDnsAccount?.(owner ?? '', accountId ?? '')
    if (resolved === undefined || resolved === null)
      return null
    return { owner: owner ?? '', accountId: accountId ?? '', provider: resolved.provider }
  }

  /** The route that answers for a hostname, challenge prefix or not. */
  private routeForHost(host: string): ProxyRoute | undefined {
    return this.config.routes.find(route => route.enabled && route.host.toLowerCase() === host)
  }

  /**
   * The account that answers a DNS-01 challenge for one hostname.
   *
   * The route is the authority. An explicit `dnsAccount` wins; an empty one falls back
   * to the only account any route names, so a single-account setup needs no per-route
   * choice — and never to a guess among several, because writing the wrong zone fails
   * silently.
   */
  challengeAccount(fqdn: string): ChallengeAccount | null {
    const host = fqdn.startsWith('_acme-challenge.')
      ? fqdn.slice('_acme-challenge.'.length)
      : fqdn
    // Normalized here too: `handle` already normalizes, but a caller that does not
    // must not silently get "no account answers" for an upper-case or dotted name.
    return this.resolveAccount(normalizeHost(host))
  }

  private resolveAccount(host: string): ChallengeAccount | null {
    // Nothing answers a challenge while the feature is off, whatever a route names:
    // the account lookup is the last gate before a record is written.
    if (!this.config.dns01.enabled)
      return null
    // A local-only name is signed by the engine's own CA and never challenged; a
    // request for one must not reach a provider.
    if (!isPublicHost(host))
      return null
    if (this.options.resolveDnsAccount === undefined)
      return null
    const route = this.routeForHost(host)
    if (route === undefined)
      return null

    const named = this.dnsAccountRef(route)
    if (named !== null)
      return this.accountOf(named.owner, named.accountId)

    // Nothing named on this route. One account named anywhere answers for every name;
    // more than one is ambiguous rather than a reason to guess.
    const declared = new Map<string, { owner: string, accountId: string }>()
    for (const entry of this.config.routes) {
      if (!entry.enabled)
        continue
      const ref = this.dnsAccountRef(entry)
      if (ref !== null)
        declared.set(`${ref.owner}/${ref.accountId}`, { owner: ref.owner, accountId: ref.accountId })
    }
    if (declared.size === 1) {
      const only = [...declared.values()][0]!
      return this.accountOf(only.owner, only.accountId)
    }
    if (declared.size > 1)
      return null

    // No route names one at all — the usual single-account setup. The only account in
    // the panel that can answer is the obvious reading of "Automatic"; without this
    // the challenge block was never generated and the certificate stayed pending.
    const usable = (this.options.listDnsAccounts?.() ?? []).filter(entry => entry.writesTxt && entry.hasCredentials)
    if (usable.length !== 1)
      return null
    const only = usable[0]!
    return this.accountOf(only.workspace, only.account)
  }

  private accountOf(workspaceId: string, accountId: string): ChallengeAccount | null {
    const found = this.options.resolveDnsAccount?.(workspaceId, accountId)
    if (found === undefined || found === null || found.credentials === null)
      return null
    return { workspaceId, accountId, provider: found.provider, credentials: found.credentials }
  }

  /**
   * What a route's `dnsAccount` refers to, for the save-time check.
   *
   * A bare id belongs to the default workspace, which is what a person typing one
   * account means; `<workspace>/<id>` crosses into another.
   */
  checkDnsAccount(reference: string, workspaceId = ''): DnsAccountCheck | null {
    const named = reference.trim()
    if (named.length === 0)
      return null
    // A bare id belongs to the route's own workspace, exactly as the challenge path
    // reads it — otherwise the same string could be checked in one workspace and
    // used from another.
    const owner = named.includes('/') ? named.split('/', 2)[0] ?? '' : workspaceId.length > 0 ? workspaceId : this.options.defaultWorkspaceId?.() ?? ''
    const accountId = named.includes('/') ? named.split('/', 2)[1] ?? '' : named
    const found = this.options.resolveDnsAccount?.(owner, accountId)
    if (found === undefined || found === null)
      return null
    return {
      provider: found.provider,
      writesTxt: ddnsProvider(found.provider)?.challenge !== undefined,
      hasCredentials: found.credentials !== null,
    }
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
  private certSnapshot(): { at: number, key: string, days: number | null, issued: Map<string, { notAfter: number, issuer: string }>, local: Map<string, { notAfter: number, lifetimeMs: number }>, views: ProxyCertificateView[] } {
    const key = this.certKey()
    if (this.certCache !== null && this.certCache.key === key && Date.now() - this.certCache.at < 15_000)
      return this.certCache
    const views = this.readCertificateViews()
    const issued = this.readIssuedCertificates()
    const local = this.readLocalCertificates()
    const values = [...issued.values()]
    const soonest = values.length === 0 ? null : Math.min(...values.map(entry => entry.notAfter))
    this.certCache = {
      at: Date.now(),
      key,
      days: soonest === null ? null : Math.floor((soonest - Date.now()) / 86_400_000),
      issued,
      local,
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
  private certificateFor(route: ProxyRoute): { state: ProxyCertificateState, message: string | null, retryInMinutes?: number } {
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

    // The engine fell back to its own CA: the name is served, but not by a trusted
    // issuer. It is not `pending` — nothing is still coming unless the engine tries
    // again — and not `failed`, because the name answers.
    const local = this.localCertificates().get(route.host.toLowerCase())
    if (local !== undefined) {
      return {
        state: 'fallback',
        message: failure ?? 'the CA has not issued for this name',
        retryInMinutes: retryWindowMinutes(local.lifetimeMs),
      }
    }

    return failure === undefined
      ? { state: 'pending', message: 'the engine is waiting for a certificate' }
      : { state: 'failed', message: failure }
  }

  /** Managed certificates the engine holds, by hostname. */
  private issuedCertificates(): Map<string, { notAfter: number, issuer: string }> {
    return this.certSnapshot().issued
  }

  /** Certificates the engine's own CA issued, by hostname. */
  private localCertificates(): Map<string, { notAfter: number, lifetimeMs: number }> {
    return this.certSnapshot().local
  }

  /**
   * The engine's own certificates, which `readIssuedCertificates` skips on purpose.
   *
   * A public name in here means the CA would not issue and the engine fell back to
   * its own CA — a state worth its own name, because the name is served but not by a
   * trusted issuer, and it clears itself when the engine next tries the CA.
   */
  private readLocalCertificates(): Map<string, { notAfter: number, lifetimeMs: number }> {
    const found = new Map<string, { notAfter: number, lifetimeMs: number }>()
    const root = path.join(this.options.engineDir, 'data', 'certificates', 'local')
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    }
    catch {
      return found
    }
    for (const entry of entries) {
      if (!entry.isDirectory())
        continue
      try {
        const x509 = new X509Certificate(fs.readFileSync(path.join(root, entry.name, `${entry.name}.crt`)))
        const notAfter = new Date(x509.validTo).getTime()
        const notBefore = new Date(x509.validFrom).getTime()
        for (const host of namesOf(x509))
          found.set(host, { notAfter, lifetimeMs: Math.max(0, notAfter - notBefore) })
      }
      catch {
        // Not a PEM we can read; it is not evidence about any certificate.
      }
    }
    return found
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
      // A later success clears it, so a name that recovered is not reported failed —
      // but only a CA issuance counts. The engine's own CA answering is the fallback
      // itself, and letting that clear the reason would hide why the CA refused.
      if (inner.msg === 'certificate obtained successfully' && inner.issuer !== 'local')
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
  /**
   * True while a process from the installed binary is alive, however the panel's view
   * reads. `live()` additionally requires a fresh heartbeat, so a nanny that died and
   * left its child behind would look gone while the binary is still in use.
   */
  private engineRunning(): boolean {
    const state = readNannyState(nannyStatePath(this.options.stateDir, PROXY_ID))
    if (state === null || state.serverId !== PROXY_ID)
      return false
    return [state.nannyPid, state.childPid].some(pid => pid !== null && pid > 0 && isProcessAlive(pid))
  }

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
    // 127.0.0.1 rather than `localhost`: the engine listens on IPv4, and a resolver
    // that answers ::1 first makes a working engine look dead.
    const urls = [`http://127.0.0.1:${httpPort}`, `https://127.0.0.1:${httpsPort}`]
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
  /**
   * Makes the engine ask the CA again for one name, without restarting it.
   *
   * Caddy keeps the certificate it holds — in memory and on disk — until the name
   * leaves its configuration, and the engine's own CA is the last issuer in the
   * policy, so a name the CA refused is served that untrusted pair and never asks
   * again until renewal. Reloading the configuration without the route is what makes
   * the engine let go; the stored pair is dropped while it is out, so putting the
   * route back leaves nothing to reuse and the engine asks the CA.
   *
   * Only this name is out of the configuration, and only for the two reloads: every
   * other route keeps serving.
   */
  async retryCertificate(routeId: string): Promise<void> {
    const route = this.config.routes.find(entry => entry.id === routeId)
    if (route === undefined)
      throw new DetailedError(`unknown route "${routeId}"`, { statusCode: 404, code: 'PROXY_ROUTE_UNKNOWN' })
    if (route.tls !== 'auto' || !isPublicHost(route.host)) {
      throw new DetailedError(`"${route.host}" is not a name a CA issues for, so there is nothing to retry`, { statusCode: 400, code: 'PROXY_CERT_NOT_MANAGED' })
    }
    if (!this.installed())
      throw new DetailedError('the proxy engine is not installed yet', { statusCode: 400, code: 'ENGINE_MISSING' })
    if (this.status().state !== 'running') {
      // Nothing is serving the certificate, so there is nothing to make it let go of.
      this.forgetCertificates(route.host)
      await this.apply({ force: true })
      return
    }

    await this.loadIntoEngine(this.render(new Set([route.id])))
    this.forgetCertificates(route.host)
    await this.apply({ force: true })
  }

  /** Removes the engine's stored certificates for one name, and nothing else. */
  private forgetCertificates(host: string): void {
    const root = path.join(this.options.engineDir, 'data', 'certificates')
    let issuers: string[]
    try {
      issuers = fs.readdirSync(root)
    }
    catch {
      // Nothing stored yet: the next attempt is already a fresh one.
      return
    }
    for (const issuer of issuers) {
      const dir = path.join(root, issuer, host)
      // The host comes from the route table and not from a request, so this is a
      // second belt rather than the only one.
      if (!dir.startsWith(`${root}${path.sep}`))
        continue
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  async apply(options: { force?: boolean } = {}): Promise<void> {
    if (!this.config.enabled || !this.installed())
      return
    // The same preflight `start()` makes: turning DNS-01 on against a running engine
    // from an older release lands here, and the user deserves the reason rather than
    // whatever Caddy says about an unknown module.
    await this.assertDns01Module()
    if (this.admin === null) {
      const stillThere = this.readAdmin()
      if (stillThere === null)
        return
      this.admin = stillThere
    }

    const rendered = this.render()
    const text = `${JSON.stringify(rendered, null, 2)}\n`
    if (options.force !== true && fs.existsSync(this.options.configPath) && fs.readFileSync(this.options.configPath, 'utf8') === text) {
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
    // The reload is also what makes the engine forget a name it no longer serves, so
    // this is the moment its stored certificate for that name is safe to drop.
    const swept = this.sweepUnroutedCertificates()
    if (swept > 0)
      logger.info(`proxy:    dropped ${swept} certificate(s) for names no longer routed`)
    this.lastError = null
    this.options.onStateChange()
  }

  /**
   * Certificates the engine holds for names it no longer serves.
   *
   * Caddy keeps a certificate until the name leaves its configuration, so a removed
   * route would leave its pair behind and re-adding the route would serve that stale
   * certificate instead of asking the CA. A *disabled* route keeps its pair: it is
   * still configured, and a temporary switch-off should not cost a new issuance.
   */
  private sweepUnroutedCertificates(): number {
    const managed = new Set(this.config.routes.filter(route => route.tls !== 'off').map(route => route.host.toLowerCase()))
    // The name the engine answers a bare-IP visitor with is not a route, but its
    // certificate is one the engine manages.
    managed.add(FALLBACK_NAME.toLowerCase())

    const root = path.join(this.options.engineDir, 'data', 'certificates')
    let issuers: string[]
    try {
      issuers = fs.readdirSync(root)
    }
    catch {
      return 0
    }

    let removed = 0
    for (const issuer of issuers) {
      const dir = path.join(root, issuer)
      let hosts: fs.Dirent[]
      try {
        hosts = fs.readdirSync(dir, { withFileTypes: true })
      }
      catch {
        continue
      }
      for (const host of hosts) {
        if (!host.isDirectory() || managed.has(host.name.toLowerCase()))
          continue
        fs.rmSync(path.join(dir, host.name), { recursive: true, force: true })
        removed += 1
      }
    }
    return removed
  }

  /** Hands a configuration to the running engine without touching the file on disk. */
  private async loadIntoEngine(rendered: Record<string, unknown>): Promise<void> {
    const result = await this.request('POST', '/load', rendered).catch((error: unknown) => {
      throw new DetailedError(`the engine did not accept the configuration: ${error instanceof Error ? error.message : String(error)}`, { statusCode: 502, code: 'ENGINE_UNREACHABLE' })
    })
    if (result.status >= 400) {
      const message = engineMessage(result.body) ?? `the engine rejected the configuration (HTTP ${result.status})`
      throw new DetailedError(message, { statusCode: 400, code: 'PROXY_CONFIG_REJECTED' })
    }
  }

  /** Advances `previous.json` only for a configuration the engine accepted. */
  private rememberConfig(text: string): void {
    // 0600: the generated configuration carries the DNS-01 challenge password in
    // cleartext, because the engine has to read it. The engine runs as this user.
    if (fs.existsSync(this.options.configPath))
      writeFileAtomic(this.options.previousConfigPath, fs.readFileSync(this.options.configPath, 'utf8'), { mode: 0o600 })
    writeFileAtomic(this.options.configPath, text, { mode: 0o600 })
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

    // 0600 here too: reverting must not hand back a world-readable configuration
    // that carries the DNS-01 challenge password.
    writeFileAtomic(this.options.configPath, previous, { mode: 0o600 })
    if (current === null)
      fs.rmSync(this.options.previousConfigPath, { force: true })
    else writeFileAtomic(this.options.previousConfigPath, current, { mode: 0o600 })
    this.lastError = null
    this.options.onStateChange()
  }

  /**
   * The engine configuration for the current route table. Throws when a route cannot
   * be built, because a half-built configuration is worse than a refused one.
   */
  private render(exclude?: ReadonlySet<string>): Record<string, unknown> {
    const blocked = this.resolveRoutes(exclude).find(view => view.status === 'error')
    if (blocked !== undefined)
      throw new DetailedError(blocked.message ?? `${blocked.route.host} cannot be routed`, { statusCode: 400, code: 'PROXY_ROUTE_INVALID' })

    const routes = this.engineRoutes(exclude)
    return renderCaddyConfig({
      config: this.config,
      admin: this.admin ?? this.unixAdmin(),
      engineDir: this.options.engineDir,
      manual: this.manualPairs(),
      acme: this.acmeAccount(routes),
      dns01: this.dns01Input(routes),
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
  private resolveRoutes(exclude?: ReadonlySet<string>): ResolvedRoute[] {
    const seen = new Map<string, string>()
    return this.config.routes.filter(route => exclude?.has(route.id) !== true).map((route): ResolvedRoute => {
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
  private engineRoutes(exclude?: ReadonlySet<string>): ProxyUpstreamRoute[] {
    return this.resolveRoutes(exclude)
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
      dnsAccounts: this.options.listDnsAccounts?.() ?? [],
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
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(this.options.binDir, 'engine.json'), 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return null
      const record = parsed as Record<string, unknown>
      // A release before this one recorded a checksum. Nothing verifies it, and the
      // file is rewritten without it on the next install, so dropping it is enough.
      // Said once: this runs on every state read, and a standing warning per frame
      // buries everything else in the log.
      if ('sha256' in record) {
        delete record.sha256
        if (!this.legacyChecksumWarned) {
          this.legacyChecksumWarned = true
          logger.warn('proxy:    dropped the recorded engine checksum; nothing verifies it')
        }
      }
      const parsedRecord = engineRecordSchema(record)
      return parsedRecord instanceof type.errors ? null : parsedRecord
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
    }
  }

  /**
   * Downloads a release from the engine's own build service. Plugins are compiled
   * in server-side, so no toolchain is involved. An empty `version` asks for the
   * current release, which is how a security fix reaches the user by pressing Update.
   *
   * Refused while the engine is up: the binary is replaced on disk, and Windows
   * will not replace a running executable at all. Stopping first is the caller's
   * move, so the panel never drops a socket that faces the internet on its own.
   */
  async install(version = ''): Promise<ProxyEngineStatus> {
    const engine = this.engine
    if (version.length > 0 && !/^v?\d+\.\d+\.\d[\w.+-]*$/.test(version)) {
      throw new DetailedError(`"${version}" is not a ${engine.info.label} version`, { statusCode: 400, code: 'INVALID_ENGINE_VERSION' })
    }
    if (this.engineRunning()) {
      throw new DetailedError(`the ${engine.info.label} engine is still running — stop it before installing another build`, { statusCode: 409, code: 'ENGINE_BUSY' })
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

    const handle = fs.openSync(target, 'w', 0o755)
    let bytes = 0
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
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

    if (process.platform !== 'win32')
      fs.chmodSync(target, 0o755)
    fs.renameSync(target, this.enginePath)

    if (process.platform !== 'win32')
      fs.chmodSync(this.enginePath, 0o755)

    // What the binary says it is, not what was asked for: the build service answers
    // a request for a version it does not have with its default release.
    // What the binary says it is. Nothing is assumed from the URL: a request that
    // names plugins is answered with the build service's current release.
    const probed = await this.probeEngineVersion()
    const record: EngineRecord = {
      engine: engine.info.id,
      version: probed ?? (download.version.length > 0 ? download.version : 'unknown'),
      source: 'downloaded',
      url: download.url,
      bytes,
      installedAt: Date.now(),
    }
    writeFileAtomic(path.join(this.options.binDir, 'engine.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    // The binary changed, so what it carries has to be read again.
    this.moduleCache = null
    logger.info(`proxy:    installed ${engine.info.label} ${record.version} (${Math.round(bytes / 1024 / 1024)} MB)`)
    this.options.onStateChange()
    return this.engineStatus()
  }

  /**
   * Runs the binary for its stdout, with a deadline. The engine is operator-supplied
   * — a replaced or wrapped binary that never exits must not hang `start()` or the
   * request that triggered it, so a timeout kills it and reads as "no answer".
   */
  private runEngine(args: string[], timeoutMs: number): Promise<string | null> {
    if (!this.installed())
      return Promise.resolve(null)
    return new Promise<string | null>((resolve) => {
      const child = spawn(this.enginePath, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      let output = ''
      let settled = false
      let timer: NodeJS.Timeout | undefined
      let killTimer: NodeJS.Timeout | undefined
      const finish = (value: string | null): void => {
        if (settled)
          return
        settled = true
        if (timer !== undefined)
          clearTimeout(timer)
        if (killTimer !== undefined)
          clearTimeout(killTimer)
        resolve(value)
      }
      timer = setTimeout(() => {
        // Polite first, then certain: a binary that ignores SIGTERM would otherwise
        // stay alive after we have already given up on it.
        child.kill()
        killTimer = setTimeout(() => child.kill('SIGKILL'), 500)
        killTimer.unref()
        finish(null)
      }, timeoutMs)
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
      })
      child.on('error', () => finish(null))
      child.on('exit', () => finish(output))
    })
  }

  /** Runs `version` once and reports what the binary actually is. */
  async probeEngineVersion(): Promise<string | null> {
    const output = await this.runEngine(['version'], this.options.engineCommandTimeoutMs ?? ENGINE_COMMAND_TIMEOUT_MS)
    return output === null ? null : this.engine.parseVersion(output)
  }

  /**
   * The modules the installed binary carries, by module name.
   *
   * A build from an earlier release has no ACMEProxy module, and a configuration
   * that names it fails inside the engine with something a person cannot act on.
   * `list-modules` answers in a few milliseconds, so asking is cheaper than the
   * support question it prevents.
   */
  async installedModules(): Promise<Set<string> | null> {
    if (!this.installed())
      return null
    if (this.moduleCache !== null)
      return this.moduleCache
    const output = await this.runEngine(['list-modules'], this.options.engineCommandTimeoutMs ?? ENGINE_COMMAND_TIMEOUT_MS)
    // No answer is not an empty answer: nothing is cached, so a later call retries.
    if (output === null)
      return null
    const modules = new Set(output.split('\n').map(line => line.trim()).filter(line => line.length > 0))
    this.moduleCache = modules
    return modules
  }

  /** The module the panel's DNS-01 configuration needs the engine to carry. */
  private async assertDns01Module(): Promise<void> {
    if (!this.config.dns01.enabled)
      return
    const modules = await this.installedModules()
    // An unreadable module list is not evidence of a missing module: the engine
    // still gets its chance, and its own log carries the reason if it refuses.
    if (modules === null || modules.has(DNS01_MODULE))
      return
    throw new DetailedError(
      `the installed ${this.engine.info.label} build has no ${DNS01_MODULE} module — update the engine to enable DNS-01`,
      { statusCode: 400, code: 'ENGINE_MODULE_NOT_INSTALLED' },
    )
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
    await this.assertDns01Module()
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

    const admin = await (this.options.chooseAdmin ?? this.chooseAdmin.bind(this))()
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
      dns01: this.dns01Input(routes),
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

    const nanny = spawn(process.execPath, nannyArgv(nannyEntryPoint(), PROXY_ID, specPath, statePath), {
      cwd: this.options.engineDir,
      env: { ...process.env, ...env, HHOSTED_HOME: dataRoot, HHOSTED_PROJECT: projectDir },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      windowsHide: true,
    })
    // A failure from an earlier attempt must not be read as this one's cause.
    this.nannyError = null
    this.nanny = nanny
    // A spawn that never happens — EMFILE/ENFILE, EACCES, or an execPath that moved —
    // emits 'error' and no 'exit' at all, and an unhandled 'error' event ends the whole
    // panel. A failure and a short life clean up identically, once.
    const nannyGone = (): void => {
      if (this.nanny !== nanny)
        return
      this.nanny = null
      // The handle is gone, so nothing it owned is ours to talk to any more — a
      // stale admin.json would have the next apply() reach for a dead socket.
      this.admin = null
      fs.rmSync(this.options.adminPath, { force: true })
      this.options.onStateChange()
    }
    nanny.on('error', (error: Error) => {
      this.nannyError = `the proxy engine's nanny could not be started: ${error.message}`
      logger.error(`proxy:    ${this.nannyError}`)
      nannyGone()
    })
    nanny.on('exit', nannyGone)

    const ready = await this.waitReady()
    if (!ready) {
      // The specific cause wins: a nanny that never spawned already recorded why.
      const failure = this.nannyError ?? `the engine did not answer on its admin endpoint within ${Math.round(READY_TIMEOUT_MS / 1000)}s: ${this.logTail()}`
      await this.stop().catch(() => undefined)
      this.lastError = failure
      throw new DetailedError(failure, { statusCode: 502, code: 'ENGINE_NOT_READY' })
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
    // The failure described the run that just ended; keeping it pinned the badge to
    // "Error" with nothing left to stop, and blocked installing another build.
    this.lastError = null
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
      // The engine can answer with headers and half a body and then destroy the
      // socket. Only the first outcome wins, so a late 'error' after 'end' is noise.
      let settled = false
      const succeed = (value: { status: number, body: string }): void => {
        if (settled)
          return
        settled = true
        resolve(value)
      }
      const fail = (error: unknown): void => {
        if (settled)
          return
        settled = true
        reject(error instanceof Error ? error : new Error(String(error)))
      }

      const request = http.request({
        ...(admin.kind === 'unix' ? { socketPath: admin.path } : { host: admin.host, port: admin.port }),
        method,
        path: urlPath,
        headers,
        timeout: ADMIN_TIMEOUT_MS,
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => succeed({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
        // A truncated response is not an answer: without these the promise never
        // settles, and everything awaiting it — apply(), start()'s waitReady() and
        // the panel tick's sync() — waits for good.
        response.on('error', fail)
        response.on('aborted', () => fail(new Error('the engine closed the connection before it answered')))
      })
      request.on('timeout', () => request.destroy(new Error('the engine did not answer in time')))
      request.on('error', fail)
      if (payload !== null)
        request.write(payload)
      request.end()
    })
  }

  private async waitReady(): Promise<boolean> {
    if (this.options.waitReady !== undefined)
      return this.options.waitReady()
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      // The nanny that was going to bring the engine up is gone — a spawn that
      // failed, or one that died with its child. Nothing answers after that, so the
      // rest of the deadline would only delay the failure that is already recorded.
      if (this.nanny === null)
        return false
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

/**
 * When the engine tries the CA again, in minutes.
 *
 * certmagic renews once a third of a certificate's lifetime is left, so two thirds
 * of it is the wait; the engine's own CA issues 12 hours by default, which is where
 * the "about 8 hours" comes from. Read from the certificate, so shortening that
 * lifetime shortens the wait too.
 */
function retryWindowMinutes(lifetimeMs: number): number {
  return Math.max(1, Math.round((lifetimeMs / 60_000) * (2 / 3)))
}

/** `host:port`, `http://host:port` or `https://host:port`; `null` when unusable. */
export function parseUpstream(value: string): { dial: string, tls: boolean } | null {
  const trimmed = value.trim()
  if (trimmed.length === 0)
    return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(withScheme)
    // `new URL` normalizes a default port away, and the scheme's own default is a
    // port all the same: without this, `http://10.0.0.5:80` was refused, and a route
    // in that state made the whole table read as invalid.
    const port = url.port.length > 0 ? url.port : url.protocol === 'https:' ? '443' : '80'
    return { dial: `${url.hostname}:${port}`, tls: url.protocol === 'https:' }
  }
  catch {
    return null
  }
}

/** What a route's `dnsAccount` resolves to, for the save-time check. */
export interface DnsAccountCheck {
  provider: string
  /** The provider can write a TXT record, which is the only thing a challenge needs. */
  writesTxt: boolean
  /** Credentials are stored for the account. */
  hasCredentials: boolean
}

/**
 * The engine policies DNS-01 needs: one per account, because a policy carries one
 * challenge provider. Names that no account answers are left out, and the caller
 * renders them on the port challenges as before.
 *
 * Pure so the grouping can be checked without an engine: getting it wrong means a
 * hostname is asked for through the wrong zone, which fails with nothing to read.
 */
export function groupDns01Policies(
  routes: readonly ProxyUpstreamRoute[],
  accountFor: (host: string) => { workspaceId: string, accountId: string, provider: string } | null,
): Array<{ account: string, provider: string, subjects: string[] }> {
  const byAccount = new Map<string, { provider: string, subjects: string[] }>()
  for (const route of routes) {
    // Only names a CA could issue for: a loopback address or a `.lan` name belongs to
    // the engine's own CA, and listing it here made Caddy try ACME for an IP.
    if (route.tls !== 'auto' || !isPublicHost(route.host))
      continue
    const account = accountFor(route.host)
    if (account === null)
      continue
    const key = `${account.workspaceId}/${account.accountId}`
    const existing = byAccount.get(key)
    if (existing === undefined)
      byAccount.set(key, { provider: account.provider, subjects: [route.host] })
    else if (!existing.subjects.includes(route.host))
      existing.subjects.push(route.host)
  }
  return [...byAccount.entries()].map(([account, group]) => ({ account, provider: group.provider, subjects: group.subjects }))
}

/** Cross-field problems ArkType cannot see, reported by the API before a save. */
export function validateProxyConfig(config: ProxyConfig, dnsAccount?: (ref: string, workspaceId: string) => DnsAccountCheck | null): string[] {
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

    // A named account has to be able to do the one thing it is named for. Catching it
    // here beats a challenge that fails weeks later with nothing to read.
    const named = route.dnsAccount.trim()
    if (named.length === 0 || dnsAccount === undefined)
      continue
    if (!config.dns01.enabled)
      errors.push(`route "${route.id}" names DNS account "${named}", but DNS-01 is switched off`)
    // The route's own workspace, which is where the challenge path looks it up too.
    const found = dnsAccount(named, route.workspace)
    if (found === null)
      errors.push(`route "${route.id}" names unknown DNS account "${named}"`)
    else if (!found.writesTxt)
      errors.push(`route "${route.id}": the "${found.provider}" account cannot write TXT records, so it cannot answer a DNS-01 challenge`)
    else if (!found.hasCredentials)
      errors.push(`route "${route.id}": the "${found.provider}" account has no credentials stored yet`)
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
