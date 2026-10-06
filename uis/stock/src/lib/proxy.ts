import type { ProxyCertificateState, ProxyConfig, ProxyDnsAccountView, ProxyRoute, ProxyRouteStatus, ProxyRouteView, ProxyRunState, ProxyTarget, ProxyTlsMode } from '@shared/contracts'
import type { ListenerDraft, RouteDraft } from '@shared/proxy-form'
import type { Tone } from '@/lib/status'
import { isPublicHost, newRouteKey } from '@shared/proxy-form'
import { toRaw } from 'vue'

export { certificateTitle, firstPublicHost, formatBytes, HOST_PATTERN, isPrivilegedPort, isPublicHost, listenerPatch, LOCAL_LISTENER, newRouteDraft, newRouteKey, parseResolvers, parseUpstream, proxyPatch, requiresEmail, retryInLabel, ROUTE_ID_PATTERN, routesEqual, routesPatch, routeUrl, sameWire, slugifyCertificateId, slugifyId, slugifyRouteId, targetSummary, toProxyRoutes, toRouteWire, uniqueCertificateId, uniqueRouteId, UNPRIVILEGED_HTTP_PORT, UNPRIVILEGED_HTTPS_PORT, usesFallbackPorts, validateRouteDraft } from '@shared/proxy-form'
export type { CertificateErrors, ListenerDraft, ProxyWorkspace, RouteDraft, RouteErrors } from '@shared/proxy-form'

/**
 * The reverse-proxy form: the route draft the table edits, the patch a save
 * sends, and the checks the panel would otherwise answer with a 400.
 */

/** The engine actions the page can run outside the paged Save. */
export type ProxyAction = 'install' | 'start' | 'stop' | 'apply' | 'revert'

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
 * Applies a dialog result to the draft list.
 *
 * `edited` is matched by route **id**, never by the row's `key`: a state frame arriving
 * while the dialog is open re-clones the list and mints a fresh key per row, so the row
 * the dialog was opened from no longer matches by key — and the edit was then dropped
 * with the dialog closing as if it had saved. An id survives the re-clone. `null` means
 * the dialog is adding, which is why the add case is not "no match found".
 */
export function applyRouteDraft(routes: readonly RouteDraft[], edited: RouteDraft | null, next: RouteDraft): RouteDraft[] {
  if (edited === null)
    return [...routes, next]
  return routes.map(route => (route.id === edited.id ? next : route))
}

/** How a route's TLS mode reads once the engine picks the certificate. */
export function tlsSummary(route: ProxyRoute): string {
  if (route.tls === 'off')
    return 'plain HTTP'
  if (route.tls === 'manual')
    return 'uploaded certificate'
  return isPublicHost(route.host) ? 'Let\u2019s Encrypt' : 'engine CA (local)'
}
