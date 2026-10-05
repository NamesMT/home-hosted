import type { ProxyCertificateState, ProxyCertificateView, ProxyConfig, ProxyDnsAccountView, ProxyPatch, ProxyRoute, ProxyRoutePatch, ProxyRouteStatus, ProxyRouteView, ProxyRunState, ProxyTarget, ProxyTlsMode } from '@shared/contracts'
import type { Tone } from '@/lib/status'
import { proxyRouteSchema } from '@shared/contracts'
import { type } from 'arktype'
import { toRaw } from 'vue'

/**
 * The reverse-proxy form: the route draft the table edits, the patch a save
 * sends, and the checks the panel would otherwise answer with a 400.
 */

/** The route as the page edits it: the config plus a stable key for `v-for`. */
export interface RouteDraft extends ProxyRoute { key: string }

/** The panel-wide block a save writes besides the route table. */
export interface ListenerDraft {
  enabled: boolean
  httpPort: number
  httpsPort: number
  email: string
  staging: boolean
  /** DNS-01: the panel answers the challenge instead of the engine using ports. */
  dns01: boolean
  /** Nameservers the engine checks the record against, as typed: one per line or comma. */
  resolvers: string
}

export interface ProxyWorkspace {
  id: string
  label: string
  servers: Array<{ id: string }>
}

export interface CertificateErrors {
  label?: string
  id?: string
  certificate?: string
  privateKey?: string
}

export interface RouteErrors {
  host?: string
  id?: string
  workspace?: string
  server?: string
  url?: string
  path?: string
  form?: string
}

export const UNPRIVILEGED_HTTP_PORT = 4480
export const UNPRIVILEGED_HTTPS_PORT = 4443

/** The engine actions the page can run outside the paged Save. */
export type ProxyAction = 'install' | 'start' | 'stop' | 'apply' | 'revert'

export const ROUTE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** The reserved and homelab TLDs a public CA cannot serve (`isPublicHost` in the panel). */
const LOCAL_TLDS = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.home', '.test', '.invalid', '.example']

export const TARGET_OPTIONS: Array<{ value: ProxyTarget, label: string }> = [
  { value: 'server', label: 'A supervised server' },
  { value: 'panel', label: 'This control panel' },
  { value: 'external', label: 'A literal upstream' },
]

export const TLS_OPTIONS: Array<{ value: ProxyTlsMode, label: string }> = [
  { value: 'auto', label: 'Automatic — the engine decides' },
  { value: 'off', label: 'Off — plain HTTP' },
  { value: 'manual', label: 'Uploaded certificate' },
]

export const RUN_STATE_META: Record<ProxyRunState, { label: string, tone: Tone, transitional: boolean }> = {
  off: { label: 'Off', tone: 'neutral', transitional: false },
  stopped: { label: 'Stopped', tone: 'neutral', transitional: false },
  starting: { label: 'Starting', tone: 'warn', transitional: true },
  running: { label: 'Running', tone: 'ok', transitional: false },
  error: { label: 'Error', tone: 'danger', transitional: false },
  unsupported: { label: 'Unsupported', tone: 'warn', transitional: false },
}

export const ROUTE_STATUS_META: Record<ProxyRouteStatus, { label: string, tone: Tone }> = {
  'ok': { label: 'Serving', tone: 'ok' },
  'disabled': { label: 'Disabled', tone: 'neutral' },
  'no-upstream': { label: 'No upstream', tone: 'warn' },
  'error': { label: 'Error', tone: 'danger' },
}

/** Where a hostname's certificate stands. `off` has nothing to say. */
export const CERTIFICATE_STATE_META: Record<ProxyCertificateState, { label: string, tone: Tone } | null> = {
  off: null,
  local: { label: 'engine CA', tone: 'neutral' },
  uploaded: { label: 'uploaded pair', tone: 'info' },
  issued: { label: 'certificate ready', tone: 'ok' },
  pending: { label: 'waiting for the CA', tone: 'warn' },
  failed: { label: 'certificate failed', tone: 'danger' },
  fallback: { label: 'Fell back to Local CA', tone: 'warn' },
}

/** How long until the engine tries the CA again, for the retry confirmation. */
/**
 * Where a route answers, for the list's link. A route with TLS off is served on the
 * plain port, and a standard port stays out of the URL.
 */
export function routeUrl(route: Pick<ProxyRoute, 'host' | 'path' | 'tls'>, httpPort: number, httpsPort: number): string | null {
  const host = route.host.trim()
  if (host.length === 0)
    return null
  const plain = route.tls === 'off'
  const port = plain ? httpPort : httpsPort
  const standard = plain ? 80 : 443
  const path = route.path.length === 0 || route.path.startsWith('/') ? route.path : `/${route.path}`
  return `${plain ? 'http' : 'https'}://${host}${port === standard ? '' : `:${port}`}${path}`
}

export function retryInLabel(minutes: number | null): string {
  // An older panel sends no interval; the engine's own CA issues 12 hours by default,
  // which certmagic's one-third renewal window turns into eight.
  if (minutes === null)
    return '~8 hours'
  if (minutes < 60)
    return `~${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.max(1, Math.round(minutes / 60))
  return `~${hours} hour${hours === 1 ? '' : 's'}`
}

/**
 * The certificate line for one route, or `null` when there is nothing to say —
 * an older panel does not send the field at all, and a route with TLS off has no
 * certificate to report.
 */
export function routeCertificate(view: ProxyRouteView): { label: string, tone: Tone, message: string | null, retryInMinutes: number | null } | null {
  const certificate = view.certificate
  if (certificate === undefined)
    return null
  // `?? null` on purpose: a state a newer panel sends and this build does not know
  // reads as "nothing to say" rather than as a badge with no label.
  const meta = CERTIFICATE_STATE_META[certificate.state] ?? null
  if (meta === null)
    return null
  return { ...meta, message: certificate.message, retryInMinutes: certificate.retryInMinutes ?? null }
}

/** One uploaded pair, as the list shows it; the files themselves are on disk. */
export function certificateTitle(certificate: Pick<ProxyCertificateView, 'label' | 'id'>): string {
  return certificate.label.trim().length > 0 ? certificate.label : certificate.id
}

const LOCAL_LISTENER = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?<authority>[^/?#]+)/i

let counter = 0

function newRouteKey(): string {
  counter += 1
  return `proxy-route-${counter}`
}

/** A name an ACME CA could issue for; anything else gets the engine's own CA. */
export function isPublicHost(host: string): boolean {
  const name = host.trim().toLowerCase()
  if (name.length === 0 || name === 'localhost' || !name.includes('.'))
    return false
  if (LOCAL_TLDS.some(tld => name.endsWith(tld)))
    return false
  return !IPV4_PATTERN.test(name)
}

export function isPrivilegedPort(port: number): boolean {
  return port > 0 && port < 1024
}

/** True while the ports are the unprivileged pair this page offers as a switch. */
export function usesFallbackPorts(config: Pick<ProxyConfig, 'httpPort' | 'httpsPort'>): boolean {
  return config.httpPort === UNPRIVILEGED_HTTP_PORT && config.httpsPort === UNPRIVILEGED_HTTPS_PORT
}

export function listenerDraft(config: ProxyConfig): ListenerDraft {
  return {
    enabled: config.enabled,
    httpPort: config.httpPort,
    httpsPort: config.httpsPort,
    email: config.email,
    staging: config.staging,
    dns01: config.dns01.enabled,
    resolvers: config.dns01.resolvers.join(', '),
  }
}

/** Nameservers as typed: split on commas or newlines, trimmed, empties dropped. */
export function parseResolvers(value: string): string[] {
  return value.split(/[\s,]+/).map(entry => entry.trim()).filter(entry => entry.length > 0)
}

/**
 * The account picker's options. The empty value is the single-account fallback, so a
 * one-account setup needs no per-route choice; an account that cannot answer a
 * challenge is still listed, marked, so a person sees why it is not a candidate.
 */
export function dnsAccountOptions(accounts: readonly ProxyDnsAccountView[]): Array<{ value: string, label: string }> {
  const options = [{ value: '', label: 'Automatic (the only account that can answer)' }]
  for (const account of accounts) {
    const name = account.label.length > 0 ? account.label : account.account
    const marks = [
      !account.writesTxt ? 'no TXT support' : null,
      account.writesTxt && !account.hasCredentials ? 'no credentials' : null,
    ].filter((mark): mark is string => mark !== null)
    options.push({
      value: `${account.workspace}/${account.account}`,
      label: `${name} · ${account.provider} · ${account.workspace}${marks.length > 0 ? ` (${marks.join(', ')})` : ''}`,
    })
  }
  return options
}

export function cloneListenerDraft(config: ProxyConfig): ListenerDraft {
  return { ...listenerDraft(config) }
}

/** A detached, plain copy of the route list, so an edit cannot reach live state. */
export function cloneRoutes(routes: readonly ProxyRoute[]): RouteDraft[] {
  return structuredClone(toRaw(routes)).map(route => ({ ...route, key: newRouteKey() }))
}

/**
 * The wire shape of a route: a row key is a UI detail, and the schema rejects
 * undeclared keys.
 */
export function toRouteWire(route: ProxyRoute): ProxyRoutePatch {
  return {
    id: route.id,
    host: route.host,
    enabled: route.enabled,
    target: route.target,
    workspace: route.workspace,
    server: route.server,
    url: route.url,
    path: route.path,
    tls: route.tls,
    dnsAccount: route.dnsAccount,
  }
}

export function toProxyRoutes(drafts: readonly RouteDraft[]): ProxyRoutePatch[] {
  return drafts.map(toRouteWire)
}

function sameWire(a: ProxyRoute, b: ProxyRoute): boolean {
  return JSON.stringify(toRouteWire(a)) === JSON.stringify(toRouteWire(b))
}

export function routesEqual(current: readonly ProxyRoute[], drafts: readonly RouteDraft[]): boolean {
  if (current.length !== drafts.length)
    return false
  return current.every((route, index) => sameWire(route, drafts[index]!))
}

/** Only the keys that differ; `null` means the route table is unchanged. */
export function routesPatch(current: readonly ProxyRoute[], drafts: readonly RouteDraft[]): ProxyRoutePatch[] | null {
  return routesEqual(current, drafts) ? null : toProxyRoutes(drafts)
}

export function listenerPatch(current: ProxyConfig, draft: ListenerDraft): Partial<ProxyPatch> {
  const patch: Partial<ProxyPatch> = {}
  if (current.enabled !== draft.enabled)
    patch.enabled = draft.enabled
  if (current.httpPort !== draft.httpPort)
    patch.httpPort = draft.httpPort
  if (current.httpsPort !== draft.httpsPort)
    patch.httpsPort = draft.httpsPort
  if (current.email !== draft.email)
    patch.email = draft.email
  if (current.staging !== draft.staging)
    patch.staging = draft.staging
  // Sent only when it changed, so a save never rewrites a group it did not touch.
  const resolvers = parseResolvers(draft.resolvers)
  if (current.dns01.enabled !== draft.dns01 || current.dns01.resolvers.join(',') !== resolvers.join(','))
    patch.dns01 = { enabled: draft.dns01, resolvers }
  return patch
}

/** The whole patch a save sends, or `null` when nothing changed. */
export function proxyPatch(current: ProxyConfig, listener: ListenerDraft, drafts: readonly RouteDraft[]): ProxyPatch | null {
  const patch: ProxyPatch = listenerPatch(current, listener)
  const routes = routesPatch(current.routes, drafts)
  if (routes !== null)
    patch.routes = routes
  return Object.keys(patch).length === 0 ? null : patch
}

/**
 * The e-mail rule the panel enforces: a public name served over TLS needs an
 * ACME account address. A local-only name gets the engine's own CA, so a
 * LAN-only setup never needs one.
 */
export function requiresEmail(listener: Pick<ListenerDraft, 'email' | 'staging'>, routes: readonly RouteDraft[]): boolean {
  if (listener.staging || listener.email.trim().length > 0)
    return false
  return routes.some(route => route.tls !== 'off' && isPublicHost(route.host))
}

/** The first public name that would need the e-mail, for the hint to name it. */
export function firstPublicHost(routes: readonly RouteDraft[]): string | null {
  return routes.find(route => route.tls !== 'off' && isPublicHost(route.host))?.host ?? null
}

function slugifyId(value: string, fallback: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  if (slug.length === 0)
    return fallback
  return /^[a-z0-9]/.test(slug) ? slug : `r-${slug}`
}

/** An id no other entry uses: the panel refuses duplicates outright. */
function uniqueId(base: string, taken: readonly string[]): string {
  const used = new Set(taken)
  if (!used.has(base))
    return base
  let index = 2
  while (used.has(`${base}-${index}`))
    index += 1
  return `${base}-${index}`
}

export function slugifyRouteId(host: string): string {
  return slugifyId(host, 'route')
}

export function uniqueRouteId(base: string, taken: readonly string[]): string {
  return uniqueId(base, taken)
}

/** A certificate is named by its label; the id names the files on disk. */
export function slugifyCertificateId(label: string): string {
  return slugifyId(label, 'certificate')
}

export function uniqueCertificateId(base: string, taken: readonly string[]): string {
  return uniqueId(base, taken)
}

export function newRouteDraft(): RouteDraft {
  return {
    key: newRouteKey(),
    id: 'route',
    host: '',
    enabled: true,
    target: 'server',
    workspace: '',
    server: '',
    url: '',
    path: '',
    tls: 'auto',
    dnsAccount: '',
  }
}

/**
 * The panel accepts an upstream with or without a scheme, and a port is optional
 * because every scheme has a default one — the panel fills in :80 or :443.
 *
 * A typed default port is dropped on the way to the panel: `new URL` normalizes
 * `:80` on `http:` away, so `http://10.0.0.5:80` and `http://10.0.0.5` are one
 * upstream, and a route table that keeps both forms would read as unchanged after
 * a save that the panel had actually rewritten.
 */
export function parseUpstream(value: string): { host: string, port: string } | null {
  const trimmed = value.trim()
  if (trimmed.length === 0)
    return null
  const match = LOCAL_LISTENER.exec(trimmed)
  const authority = match?.groups?.authority
  if (authority === undefined || authority.length === 0)
    return null
  // An empty port (`host:`) is not one the panel could use, and `lastIndexOf` reads
  // the colons of an IPv6 literal as a port unless they are told apart first.
  if (authority.endsWith(':') || /\s/.test(authority))
    return null
  const scheme = trimmed.slice(0, trimmed.indexOf(':')).toLowerCase()
  const separator = authority.lastIndexOf(':')
  if (separator <= 0)
    return { host: authority, port: scheme === 'https' ? '443' : '80' }
  const port = authority.slice(separator + 1)
  if (!/^\d{1,5}$/.test(port))
    return null
  return { host: authority.slice(0, separator), port }
}

export function validateRouteDraft(draft: RouteDraft, options: { others: readonly RouteDraft[], workspaces: readonly ProxyWorkspace[] }): RouteErrors {
  const errors: RouteErrors = {}
  const host = draft.host.trim()

  if (host.length === 0)
    errors.host = 'a hostname is required'
  else if (!HOST_PATTERN.test(host))
    errors.host = 'a hostname of letters, digits, dots and dashes, e.g. home.example.com'
  else if (options.others.some(other => other.host.trim().toLowerCase() === host.toLowerCase() && other.path === draft.path))
    errors.host = `"${host}" is already routed for this path`

  if (draft.path.length > 0 && !draft.path.startsWith('/'))
    errors.path = 'a path prefix starts with /'
  else if (/\s/.test(draft.path))
    errors.path = 'a path prefix cannot contain a space'

  if (!ROUTE_ID_PATTERN.test(draft.id))
    errors.id = 'the id must start with a letter or digit, then letters, digits, dash or underscore'
  else if (options.others.some(other => other.id === draft.id))
    errors.id = `route id "${draft.id}" is used twice`

  if (draft.target === 'server') {
    const workspace = options.workspaces.find(entry => entry.id === draft.workspace)
    if (draft.workspace.length === 0 || workspace === undefined)
      errors.workspace = 'pick the workspace that owns the server'
    else if (draft.server.length === 0 || !workspace.servers.some(entry => entry.id === draft.server))
      errors.server = 'pick a server in that workspace'
  }

  if (draft.target === 'external' && parseUpstream(draft.url) === null)
    errors.url = 'an upstream like http://10.0.0.5:8080'

  // The schema is the last word on anything the field checks cannot see.
  const parsed = proxyRouteSchema({ ...toRouteWire(draft), host })
  if (parsed instanceof type.errors && Object.keys(errors).length === 0)
    errors.form = parsed.summary

  return errors
}

export function hasRouteErrors(errors: RouteErrors): boolean {
  return Object.keys(errors).length > 0
}

/** What the target column reads: who a route forwards to. */
export function targetSummary(route: ProxyRoute, workspaces: readonly ProxyWorkspace[]): string {
  if (route.target === 'panel')
    return 'control panel'
  if (route.target === 'external')
    return route.url.trim().length > 0 ? route.url.trim() : 'no upstream'
  if (route.workspace.length === 0 || route.server.length === 0)
    return 'no server picked'
  const workspace = workspaces.find(entry => entry.id === route.workspace)
  return `${workspace?.label ?? route.workspace} / ${route.server}`
}

/** How a route's TLS mode reads once the engine picks the certificate. */
export function tlsSummary(route: ProxyRoute): string {
  if (route.tls === 'off')
    return 'plain HTTP'
  if (route.tls === 'manual')
    return 'uploaded certificate'
  return isPublicHost(route.host) ? 'Let\u2019s Encrypt' : 'engine CA (local)'
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes <= 0)
    return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}
