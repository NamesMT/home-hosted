import type { ProxyCertificateState, ProxyConfig, ProxyDnsAccountView, ProxyRoute, ProxyRouteStatus, ProxyRouteView, ProxyRunState, ProxyTarget, ProxyTlsMode } from '@shared/contracts'
import type { ListenerDraft, RouteDraft } from '@shared/proxy-form'
import { isPublicHost, newRouteKey, proxyPatch } from '@shared/proxy-form'
import { toRaw } from 'vue'

export { certificateTitle, firstPublicHost, formatBytes, HOST_PATTERN, isPrivilegedPort, isPublicHost, listenerPatch, LOCAL_LISTENER, newRouteDraft, newRouteKey, parseResolvers, parseUpstream, proxyPatch, requiresEmail, retryInLabel, ROUTE_ID_PATTERN, routesEqual, routesPatch, routeUrl, sameWire, slugifyCertificateId, slugifyId, slugifyRouteId, targetSummary, toProxyRoutes, toRouteWire, uniqueCertificateId, uniqueRouteId, UNPRIVILEGED_HTTP_PORT, UNPRIVILEGED_HTTPS_PORT, usesFallbackPorts, validateRouteDraft } from '@shared/proxy-form'
export type { CertificateErrors, ListenerDraft, ProxyWorkspace, RouteDraft, RouteErrors } from '@shared/proxy-form'

/**
 * The reverse-proxy form: the route draft the table edits, the patch a save
 * sends, and the checks the panel would otherwise answer with a 400.
 */

/** The engine actions the page can run outside the paged save. */
export type ProxyAction = 'install' | 'start' | 'stop' | 'apply' | 'revert'

export interface ChipMeta {
  label: string
  chip: string
}

export const TARGET_OPTIONS: Array<{ value: ProxyTarget, label: string }> = [
  { value: 'server', label: 'a supervised server' },
  { value: 'panel', label: 'this control panel' },
  { value: 'external', label: 'a literal upstream' },
]

export const TLS_OPTIONS: Array<{ value: ProxyTlsMode, label: string }> = [
  { value: 'auto', label: 'auto — the engine decides' },
  { value: 'off', label: 'off — plain http' },
  { value: 'manual', label: 'uploaded certificate' },
]

export const RUN_STATE_META: Record<ProxyRunState, ChipMeta & { transitional: boolean }> = {
  off: { label: 'off', chip: 'chip--idle', transitional: false },
  stopped: { label: 'stopped', chip: 'chip--idle', transitional: false },
  starting: { label: 'starting', chip: 'chip--warn', transitional: true },
  running: { label: 'running', chip: 'chip--ok', transitional: false },
  error: { label: 'error', chip: 'chip--danger', transitional: false },
  unsupported: { label: 'unsupported', chip: 'chip--warn', transitional: false },
}

export const ROUTE_STATUS_META: Record<ProxyRouteStatus, ChipMeta> = {
  'ok': { label: 'serving', chip: 'chip--ok' },
  'disabled': { label: 'disabled', chip: 'chip--idle' },
  'no-upstream': { label: 'no upstream', chip: 'chip--warn' },
  'error': { label: 'error', chip: 'chip--danger' },
}

/** Where a hostname's certificate stands. `off` has nothing to say. */
export const CERTIFICATE_STATE_META: Record<ProxyCertificateState, ChipMeta | null> = {
  off: null,
  local: { label: 'engine CA', chip: 'chip--idle' },
  uploaded: { label: 'uploaded pair', chip: 'chip--neutral' },
  issued: { label: 'certificate ready', chip: 'chip--ok' },
  pending: { label: 'waiting for the CA', chip: 'chip--warn' },
  failed: { label: 'certificate failed', chip: 'chip--danger' },
  fallback: { label: 'Fell back to Local CA', chip: 'chip--warn' },
}

/** How long until the engine tries the CA again, for the retry confirmation. */
/** The certificate line for one route, or `null` when there is nothing to say. */
export function routeCertificate(view: ProxyRouteView): { label: string, chip: string, danger: boolean, warn: boolean, message: string | null, retryInMinutes: number | null } | null {
  const certificate = view.certificate
  if (certificate === undefined)
    return null
  // A state a newer panel sends and this build does not know reads as nothing to say.
  const meta = CERTIFICATE_STATE_META[certificate.state] ?? null
  if (meta === null)
    return null
  return {
    label: meta.label,
    chip: meta.chip,
    danger: certificate.state === 'failed',
    // A fallback is a warning, not a failure: the name answers, just not trusted.
    warn: certificate.state === 'pending' || certificate.state === 'fallback',
    message: certificate.message,
    retryInMinutes: certificate.retryInMinutes ?? null,
  }
}

export function cloneListenerDraft(config: ProxyConfig): ListenerDraft {
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
 * Which port a listener field should actually hold, given what its input reported.
 *
 * `v-model.number` writes an empty **string** when the box is cleared — not a number and not
 * null — and that string reached `patchProxy`'s own `proxyPatchSchema`, which rejects the
 * whole patch with "httpPort must be a number (was a string)" before sending anything, taking
 * every other pending proxy edit with it. Clearing a box to retype a value is ordinary, so
 * keep the last valid port while it is empty.
 */
export function keepPort(value: unknown, current: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535 ? Math.trunc(parsed) : current
}

/**
 * The account picker's options. The empty value is the single-account fallback, so a
 * one-account setup needs no per-route choice; an account that cannot answer a
 * challenge is still listed, marked, so a person sees why it is not a candidate.
 */
export function dnsAccountOptions(accounts: readonly ProxyDnsAccountView[]): Array<{ value: string, label: string }> {
  const options = [{ value: '', label: 'automatic (the only account that can answer)' }]
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

/** A detached, plain copy of the route list, so an edit cannot reach live state. */
export function cloneRoutes(routes: readonly ProxyRoute[]): RouteDraft[] {
  return structuredClone(toRaw(routes)).map(route => ({ ...route, key: newRouteKey() }))
}

/**
 * Applies a dialog result to the draft list.
 *
 * `edited` is matched by route **id**, never by the row's `key`: a state frame arriving
 * while the dialog is open re-clones the list and mints a fresh key per row, so the row the
 * dialog was opened from no longer matches by key — and the edit was then dropped with the
 * dialog closing as if it had saved. An id survives the re-clone. `null` means the dialog
 * is adding, which is why the add case is not "no match found".
 */
export function applyRouteDraft(routes: readonly RouteDraft[], edited: RouteDraft | null, next: RouteDraft): RouteDraft[] {
  if (edited === null)
    return [...routes, next]
  return routes.map(route => (route.id === edited.id ? next : route))
}

export function changedKeys(current: ProxyConfig, listener: ListenerDraft, drafts: readonly RouteDraft[]): number {
  const patch = proxyPatch(current, listener, drafts)
  if (patch === null)
    return 0
  const listenerKeys = Object.keys(patch).filter(key => key !== 'routes').length
  return listenerKeys + (patch.routes === undefined ? 0 : 1)
}

/** How a route's TLS mode reads once the engine picks the certificate. */
export function tlsSummary(route: ProxyRoute): string {
  if (route.tls === 'off')
    return 'plain http'
  if (route.tls === 'manual')
    return 'uploaded cert'
  return isPublicHost(route.host) ? 'acme' : 'local ca'
}
