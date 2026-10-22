import type { ProxyCertificateView, ProxyConfig, ProxyPatch, ProxyRoute, ProxyRoutePatch } from './contracts'
import { type } from 'arktype'
import { proxyRouteSchema } from './contracts'
import { mergeReplacedList } from './patch-diff'

/**
 * The reverse-proxy form, shared by both UIs: the route draft the table edits, the patch a save
 * sends, and the checks the panel would otherwise answer with a 400.
 *
 * These 40 declarations were identical copies in `uis/stock` and `uis/noc-console`
 * (`parseUpstream` differs only in a doc comment, so it takes the fuller one). Eight commits had
 * touched both files, one literally "carry the fix into the other UI" — a measured cost.
 *
 * `cloneRoutes` deliberately stays in each UI: it calls Vue's `toRaw`, and this module must not
 * depend on Vue — the UIs bundle it as a devDependency while the published package does not ship
 * it, so a Vue import here would break the server if it ever imported this file.
 */

export interface CertificateErrors {
  label?: string
  id?: string
  certificate?: string
  privateKey?: string
}

export const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i

export const LOCAL_LISTENER = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?<authority>[^/?#]+)/i

export /** The reserved and homelab TLDs a public CA cannot serve (`isPublicHost` in the panel). */
const LOCAL_TLDS = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.home', '.test', '.invalid', '.example']

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

export const ROUTE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

/** The route as the page edits it: the config plus a stable key for `v-for`. */
export interface RouteDraft extends ProxyRoute { key: string }

export interface RouteErrors {
  host?: string
  id?: string
  workspace?: string
  server?: string
  url?: string
  path?: string
  form?: string
}

/**
 * The sentences `validateRouteDraft` puts in {@link RouteErrors}, as a seam for translation.
 *
 * The rules belong here — both UIs must refuse the same input for the same reason — but the
 * wording does not: a UI shipping more than one language has to render these in the reader's
 * language, and `src/shared/` may not import Vue or the UI's i18n. So the caller passes messages
 * and the defaults keep every existing caller's output byte-identical.
 */
export interface RouteErrorMessages {
  hostRequired: () => string
  hostInvalid: () => string
  hostDuplicate: (host: string) => string
  pathNeedsSlash: () => string
  pathHasSpace: () => string
  idInvalid: () => string
  idDuplicate: (id: string) => string
  workspaceRequired: () => string
  serverRequired: () => string
  urlInvalid: () => string
}

/** The default wording, unchanged from when it was inlined in `validateRouteDraft`. */
const ENGLISH_ROUTE_ERROR_MESSAGES: RouteErrorMessages = {
  hostRequired: () => 'a hostname is required',
  hostInvalid: () => 'a hostname of letters, digits, dots and dashes, e.g. home.example.com',
  hostDuplicate: host => `"${host}" is already routed for this path`,
  pathNeedsSlash: () => 'a path prefix starts with /',
  pathHasSpace: () => 'a path prefix cannot contain a space',
  idInvalid: () => 'the id must start with a letter or digit, then letters, digits, dash or underscore',
  idDuplicate: id => `route id "${id}" is used twice`,
  workspaceRequired: () => 'pick the workspace that owns the server',
  serverRequired: () => 'pick a server in that workspace',
  urlInvalid: () => 'an upstream like http://10.0.0.5:8080',
}

/** The words the route list shows for a target or a retry delay, as a translation seam. */
export interface RouteSummaryLabels {
  controlPanel: () => string
  noUpstream: () => string
  noServerPicked: () => string
  fallbackRetry: () => string
  retryOne: (count: number, unit: 'minute' | 'hour') => string
  retryMany: (count: number, unit: 'minute' | 'hour') => string
}

const ENGLISH_ROUTE_SUMMARY_LABELS: RouteSummaryLabels = {
  controlPanel: () => 'control panel',
  noUpstream: () => 'no upstream',
  noServerPicked: () => 'no server picked',
  fallbackRetry: () => '~8 hours',
  // `minute`/`hour` carry their own plural: English needs `s`, Russian needs three forms.
  retryOne: (count, unit) => `~${count} ${unit}`,
  retryMany: (count, unit) => `~${count} ${unit}s`,
}

export const UNPRIVILEGED_HTTPS_PORT = 4443

export const UNPRIVILEGED_HTTP_PORT = 4480

/** One uploaded pair, as the list shows it; the files themselves are on disk. */
export function certificateTitle(certificate: Pick<ProxyCertificateView, 'label' | 'id'>): string {
  return certificate.label.trim().length > 0 ? certificate.label : certificate.id
}

let counter = 0

/** The first public name that would need the e-mail, for the hint to name it. */
export function firstPublicHost(routes: readonly RouteDraft[]): string | null {
  return routes.find(route => route.tls !== 'off' && isPublicHost(route.host))?.host ?? null
}

export function formatBytes(bytes: number | null): string {
  // Only `null` (and a nonsensical negative) is unknown. **0 is an answer** — an empty log, an empty
  // backup, a just-started engine — and rendering it as the em-dash claimed the size could not be
  // measured when it had been measured as nothing.
  if (bytes === null || bytes < 0)
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

export function isPrivilegedPort(port: number): boolean {
  return port > 0 && port < 1024
}

/** A name an ACME CA could issue for; anything else gets the engine's own CA. */
export function isPublicHost(host: string): boolean {
  const name = host.trim().toLowerCase()
  if (name.length === 0 || name === 'localhost' || !name.includes('.'))
    return false
  if (LOCAL_TLDS.some(tld => name.endsWith(tld)))
    return false
  // Four octets is an IPv4 literal, and more still reads as dotted digits rather
  // than a registrable name — a CA could never issue for `1.2.3.4.5`.
  return !/^\d{1,3}(?:\.\d{1,3}){3,}$/.test(name)
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

export function newRouteKey(): string {
  counter += 1
  return `proxy-route-${counter}`
}

/** Nameservers as typed: split on commas or newlines, trimmed, empties dropped. */
export function parseResolvers(value: string): string[] {
  return value.split(/[\s,]+/).map(entry => entry.trim()).filter(entry => entry.length > 0)
}

/** The whole patch a save sends, or `null` when nothing changed. */
export function proxyPatch(
  current: ProxyConfig,
  listener: ListenerDraft,
  drafts: readonly RouteDraft[],
  filledRoutes?: readonly ProxyRoute[],
): ProxyPatch | null {
  const patch: ProxyPatch = listenerPatch(current, listener)
  const routes = routesPatch(current.routes, drafts, filledRoutes)
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

export function retryInLabel(minutes: number | null, labels: RouteSummaryLabels = ENGLISH_ROUTE_SUMMARY_LABELS): string {
  // An older panel sends no interval; the engine's own CA issues 12 hours by default,
  // which certmagic's one-third renewal window turns into eight.
  if (minutes === null)
    return labels.fallbackRetry()
  if (minutes < 60)
    return minutes === 1 ? labels.retryOne(minutes, 'minute') : labels.retryMany(minutes, 'minute')
  const hours = Math.max(1, Math.round(minutes / 60))
  return hours === 1 ? labels.retryOne(hours, 'hour') : labels.retryMany(hours, 'hour')
}

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

export function routesEqual(current: readonly ProxyRoute[], drafts: readonly RouteDraft[]): boolean {
  if (current.length !== drafts.length)
    return false
  return current.every((route, index) => sameWire(route, drafts[index]!))
}

/**
 * The route table to send, or `null` when unchanged.
 *
 * `filled` is the table this form was filled with. With it the patch is a three-way merge, so a
 * route another client added while the page was open survives a save from this one; without it the
 * draft's whole view is sent, which is only safe when the caller knows it holds the current table.
 */
export function routesPatch(
  current: readonly ProxyRoute[],
  drafts: readonly RouteDraft[],
  filled?: readonly ProxyRoute[],
): ProxyRoutePatch[] | null {
  if (filled === undefined)
    return routesEqual(current, drafts) ? null : toProxyRoutes(drafts)
  const merged = mergeReplacedList({
    filled: filled.map(toRouteWire),
    draft: toProxyRoutes(drafts),
    live: current.map(toRouteWire),
    key: route => route.id,
  })
  return merged
}

export function sameWire(a: ProxyRoute, b: ProxyRoute): boolean {
  return JSON.stringify(toRouteWire(a)) === JSON.stringify(toRouteWire(b))
}

/** A certificate is named by its label; the id names the files on disk. */
export function slugifyCertificateId(label: string): string {
  return slugifyId(label, 'certificate')
}

export function slugifyId(value: string, fallback: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  if (slug.length === 0)
    return fallback
  return /^[a-z0-9]/.test(slug) ? slug : `r-${slug}`
}

export function slugifyRouteId(host: string): string {
  return slugifyId(host, 'route')
}

/** What the target column reads: who a route forwards to. */
export function targetSummary(route: ProxyRoute, workspaces: readonly ProxyWorkspace[], labels: RouteSummaryLabels = ENGLISH_ROUTE_SUMMARY_LABELS): string {
  if (route.target === 'panel')
    return labels.controlPanel()
  if (route.target === 'external')
    return route.url.trim().length > 0 ? route.url.trim() : labels.noUpstream()
  if (route.workspace.length === 0 || route.server.length === 0)
    return labels.noServerPicked()
  const workspace = workspaces.find(entry => entry.id === route.workspace)
  return `${workspace?.label ?? route.workspace} / ${route.server}`
}

export function toProxyRoutes(drafts: readonly RouteDraft[]): ProxyRoutePatch[] {
  return drafts.map(toRouteWire)
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

export function uniqueCertificateId(base: string, taken: readonly string[]): string {
  return uniqueId(base, taken)
}

export /** An id no other entry uses: the panel refuses duplicates outright. */
function uniqueId(base: string, taken: readonly string[]): string {
  const used = new Set(taken)
  if (!used.has(base))
    return base
  let index = 2
  while (used.has(`${base}-${index}`))
    index += 1
  return `${base}-${index}`
}

export function uniqueRouteId(base: string, taken: readonly string[]): string {
  return uniqueId(base, taken)
}

/** True while the ports are the unprivileged pair this page offers as a switch. */
export function usesFallbackPorts(config: Pick<ProxyConfig, 'httpPort' | 'httpsPort'>): boolean {
  return config.httpPort === UNPRIVILEGED_HTTP_PORT && config.httpsPort === UNPRIVILEGED_HTTPS_PORT
}

export function validateRouteDraft(draft: RouteDraft, options: { others: readonly RouteDraft[], workspaces: readonly ProxyWorkspace[], messages?: Partial<RouteErrorMessages> }): RouteErrors {
  const messages = { ...ENGLISH_ROUTE_ERROR_MESSAGES, ...options.messages }
  const errors: RouteErrors = {}
  const host = draft.host.trim()

  if (host.length === 0)
    errors.host = messages.hostRequired()
  else if (!HOST_PATTERN.test(host))
    errors.host = messages.hostInvalid()
  // `/app` and `/app/` render overlapping matchers, so one would shadow the other.
  else if (options.others.some(other => other.host.trim().toLowerCase() === host.toLowerCase() && other.path.replace(/\/+$/, '') === draft.path.replace(/\/+$/, '')))
    errors.host = messages.hostDuplicate(host)

  if (draft.path.length > 0 && !draft.path.startsWith('/'))
    errors.path = messages.pathNeedsSlash()
  else if (/\s/.test(draft.path))
    errors.path = messages.pathHasSpace()

  if (!ROUTE_ID_PATTERN.test(draft.id))
    errors.id = messages.idInvalid()
  else if (options.others.some(other => other.id === draft.id))
    errors.id = messages.idDuplicate(draft.id)

  if (draft.target === 'server') {
    const workspace = options.workspaces.find(entry => entry.id === draft.workspace)
    if (draft.workspace.length === 0 || workspace === undefined)
      errors.workspace = messages.workspaceRequired()
    else if (draft.server.length === 0 || !workspace.servers.some(entry => entry.id === draft.server))
      errors.server = messages.serverRequired()
  }

  if (draft.target === 'external' && parseUpstream(draft.url) === null)
    errors.url = messages.urlInvalid()

  // The schema is the last word on anything the field checks cannot see.
  const parsed = proxyRouteSchema({ ...toRouteWire(draft), host })
  if (parsed instanceof type.errors && Object.keys(errors).length === 0)
    errors.form = parsed.summary

  return errors
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
