import type { GlobalSettingsStore } from '#src/config/settings'
import type { ProxyCertificateState, ProxyCertificateView, ProxyConfig, ProxyRoute } from '#src/shared/contracts'
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DetailedError } from '@namesmt/utils'
import { TlsStore } from '#src/services/tls'
import { errorMessage } from '#src/shared/error-message'
import { isPublicHost } from '#src/shared/proxy-form'

/**
 * The certificate desk: every uploaded pair, what it covers, and why the engine refused one.
 *
 * Split out of `ProxyService`, which had grown to 2233 lines and carried this, the engine's
 * lifecycle, the route table and the admin transport in one class. The method bodies here are moved
 * **verbatim** — `test/services/proxy.test.ts` and `proxy-cover.test.ts` are the proof — and only the
 * dependencies are rewired: `this.options` became `this.deps`, and the two cache invalidations the
 * owning service watches became a callback.
 *
 * It owns three things the service must not: the parsed certificate snapshot, the engine-log failure
 * map, and the pair store. Nothing else moved.
 */

const PROXY_ID = 'proxy'

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

/**
 * Does a route's certificate cover this host?
 *
 * A `*.example.com` entry covers exactly one label (`www.example.com`, not `a.b.example.com` and not
 * `example.com`), which is what a wildcard certificate means; anything else is an exact match, case
 * insensitive.
 */
export function coversHost(hosts: readonly string[], host: string): boolean {
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

/**
 * How long until the engine's internal CA should issue again, given the lifetime it used.
 *
 * Two thirds of the span, floored at a minute: renewing early is cheap, and a certificate that
 * lapses is not.
 */
function retryWindowMinutes(lifetimeMs: number): number {
  return Math.max(1, Math.round((lifetimeMs / 60_000) * (2 / 3)))
}

/** What the desk needs from the service that owns it. */
export interface CertificateDeskDeps {
  tlsDir: string
  stateDir: string
  logDir: string
  engineDir: string
  settings: GlobalSettingsStore
  /** The current proxy config; a thunk, because the service replaces it on every save. */
  config: () => ProxyConfig
  /** The service re-applies on the next tick; a pair change is what it watches for. */
  onChanged: () => void
}

export class CertificateDesk {
  /** Cached certificate verdicts, invalidated by `invalidate`. */
  private certCache: { at: number, key: string, days: number | null, issued: Map<string, { notAfter: number, issuer: string }>, local: Map<string, { notAfter: number, lifetimeMs: number }>, views: ProxyCertificateView[] } | null = null
  /** The parsed failure map, keyed on the log's identity — see `obtainFailures`. */
  private failureCache: { stamp: string, failures: Map<string, string> } | null = null

  constructor(private readonly deps: CertificateDeskDeps) {}

  /** The config lives on the service; read through the thunk rather than holding a stale copy. */
  private get config(): ProxyConfig {
    return this.deps.config()
  }

  /** Drops the cached verdicts, so the next read sees a pair that just changed. */
  invalidate(): void {
    this.certCache = null
  }

  pairStore(id: string): TlsStore {
    return new TlsStore(this.deps.tlsDir, id)
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
    this.deps.settings.updateProxy({ certificates })
    this.invalidate()
    this.deps.onChanged()
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
    this.deps.settings.updateProxy({ certificates: this.config.certificates.filter(entry => entry.id !== id) })
    this.invalidate()
    this.deps.onChanged()
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
  certSnapshot(): { at: number, key: string, days: number | null, issued: Map<string, { notAfter: number, issuer: string }>, local: Map<string, { notAfter: number, lifetimeMs: number }>, views: ProxyCertificateView[] } {
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
  bestCover(host: string): ProxyCertificateView | null {
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
        return { ...base, error: `unreadable certificate: ${errorMessage(error)}` }
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
  certificateFor(route: ProxyRoute): { state: ProxyCertificateState, message: string | null, retryInMinutes?: number } {
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

    if (!isPublicHost(route.host)) {
      // A local-only name is signed by the engine's own CA — but only once that CA has
      // actually issued it. Saying "signed" from the hostname alone meant the page read
      // `local` while the handshake failed (`tlsv1 alert internal error`) and the cleartext
      // port redirected into it, because readiness is what decides between the redirect and
      // the notice page. Until the leaf is there it is pending, and a refusal the engine
      // logged is `failed` with the engine's own reason.
      if (this.localCertificates().has(route.host.toLowerCase()))
        return { state: 'local', message: 'signed by the engine\'s own CA' }
      const refusal = this.obtainFailures().get(route.host.toLowerCase())
      return refusal === undefined
        ? { state: 'pending', message: 'the engine is issuing its own certificate' }
        : { state: 'failed', message: refusal }
    }

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
    const root = path.join(this.deps.engineDir, 'data', 'certificates', 'local')
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
    const root = path.join(this.deps.engineDir, 'data', 'certificates')
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
   *
   * Memoised on the file's identity and mtime, because this is called **per route** from
   * `routeViews()` — which `view()` runs for every state frame and `sync()` runs every tick.
   * Each call read the whole log (bounded at 2 MB by rotation), split every line and kept the
   * last 400: ~1.3 ms each, so ~13 ms of blocking synchronous I/O per second at ten routes,
   * for a file that only changes when the engine tries to obtain a certificate.
   *
   * The key is `ino` + `mtimeMs` + size, not mtime alone: rotation replaces the file, and a
   * replacement can land in the same millisecond as the previous read.
   */
  private obtainFailures(): Map<string, string> {
    const file = path.join(this.deps.logDir, `${PROXY_ID}.log`)

    let stamp: string
    try {
      const stats = fs.statSync(file)
      stamp = `${stats.ino}:${stats.mtimeMs}:${stats.size}`
    }
    catch {
      // No log is a real answer, and it must not be cached as one: the engine may write it a
      // moment from now.
      this.failureCache = null
      return new Map()
    }

    if (this.failureCache !== null && this.failureCache.stamp === stamp)
      return this.failureCache.failures

    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    }
    catch {
      return new Map()
    }

    const failures = this.parseFailures(text, new Map())
    this.failureCache = { stamp, failures }
    return failures
  }

  private parseFailures(text: string, failures: Map<string, string>): Map<string, string> {
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
}
