import type { ProxyCertificateState, ProxyConfig, ProxyDnsAccountView, ProxyRoute, ProxyRouteStatus, ProxyRouteView, ProxyRunState, ProxyTarget, ProxyTlsMode } from '@shared/contracts'
import type { ListenerDraft, ProxyWorkspace, RouteDraft, RouteErrorMessages, RouteSummaryLabels } from '@shared/proxy-form'
import type { Tone } from '@/lib/status'
import { isPublicHost, newRouteKey, retryInLabel as sharedRetryInLabel, targetSummary as sharedTargetSummary } from '@shared/proxy-form'
import { toRaw } from 'vue'
import { t, tc } from '@/i18n'

export { certificateTitle, firstPublicHost, formatBytes, HOST_PATTERN, isPrivilegedPort, isPublicHost, listenerPatch, LOCAL_LISTENER, newRouteDraft, newRouteKey, parseResolvers, parseUpstream, proxyPatch, requiresEmail, ROUTE_ID_PATTERN, routesEqual, routesPatch, routeUrl, sameWire, slugifyCertificateId, slugifyId, slugifyRouteId, toProxyRoutes, toRouteWire, uniqueCertificateId, uniqueRouteId, UNPRIVILEGED_HTTP_PORT, UNPRIVILEGED_HTTPS_PORT, usesFallbackPorts, validateRouteDraft } from '@shared/proxy-form'
export type { CertificateErrors, ListenerDraft, ProxyWorkspace, RouteDraft, RouteErrors } from '@shared/proxy-form'

/**
 * The reverse-proxy form: the route draft the table edits, the patch a save
 * sends, and the checks the panel would otherwise answer with a 400.
 */

/** The engine actions the page can run outside the paged Save. */
export type ProxyAction = 'install' | 'start' | 'stop' | 'apply' | 'revert'

export const TARGET_OPTIONS: Array<{ value: ProxyTarget, labelKey: string }> = [
  { value: 'server', labelKey: 'proxy.target.server' },
  { value: 'panel', labelKey: 'proxy.target.panel' },
  { value: 'external', labelKey: 'proxy.target.external' },
]

export const TLS_OPTIONS: Array<{ value: ProxyTlsMode, labelKey: string }> = [
  { value: 'auto', labelKey: 'proxy.tls.auto' },
  { value: 'off', labelKey: 'proxy.tls.off' },
  { value: 'manual', labelKey: 'proxy.tls.manual' },
]

export const RUN_STATE_META: Record<ProxyRunState, { labelKey: string, tone: Tone, transitional: boolean }> = {
  off: { labelKey: 'proxy.status.off', tone: 'neutral', transitional: false },
  stopped: { labelKey: 'proxy.status.stopped', tone: 'neutral', transitional: false },
  starting: { labelKey: 'proxy.status.starting', tone: 'warn', transitional: true },
  running: { labelKey: 'proxy.status.running', tone: 'ok', transitional: false },
  error: { labelKey: 'proxy.status.error', tone: 'danger', transitional: false },
  unsupported: { labelKey: 'proxy.status.unsupported', tone: 'warn', transitional: false },
}

export const ROUTE_STATUS_META: Record<ProxyRouteStatus, { labelKey: string, tone: Tone }> = {
  'ok': { labelKey: 'proxy.status.serving', tone: 'ok' },
  'disabled': { labelKey: 'proxy.status.disabled', tone: 'neutral' },
  'no-upstream': { labelKey: 'proxy.status.noUpstream', tone: 'warn' },
  'error': { labelKey: 'proxy.status.error', tone: 'danger' },
}

/** Where a hostname's certificate stands. `off` has nothing to say. */
export const CERTIFICATE_STATE_META: Record<ProxyCertificateState, { labelKey: string, tone: Tone } | null> = {
  off: null,
  local: { labelKey: 'proxy.status.localCa', tone: 'neutral' },
  uploaded: { labelKey: 'proxy.status.uploaded', tone: 'info' },
  issued: { labelKey: 'proxy.status.certified', tone: 'ok' },
  pending: { labelKey: 'proxy.status.awaitingCa', tone: 'warn' },
  failed: { labelKey: 'proxy.status.failed', tone: 'danger' },
  fallback: { labelKey: 'proxy.status.fellBack', tone: 'warn' },
}

/**
 * The certificate line for one route, or `null` when there is nothing to say —
 * an older panel does not send the field at all, and a route with TLS off has no
 * certificate to report.
 */
export function routeCertificate(view: ProxyRouteView): { labelKey: string, tone: Tone, message: string | null, retryInMinutes: number | null } | null {
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
  const options = [{ value: '', label: t('proxy.account.automatic') }]
  for (const account of accounts) {
    const name = account.label.length > 0 ? account.label : account.account
    const marks = [
      !account.writesTxt ? t('proxy.account.noTxt') : null,
      account.writesTxt && !account.hasCredentials ? t('proxy.account.noCredentials') : null,
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
    return t('proxy.tls.plain')
  if (route.tls === 'manual')
    return t('proxy.tls.uploaded')
  return isPublicHost(route.host) ? t('proxy.tls.letsEncrypt') : t('proxy.tls.engineCa')
}

/**
 * The words the shared form returns for a target or a retry delay, in the reader's language.
 *
 * The rules stay in `@shared/proxy-form` so both UIs refuse the same input for the same reason;
 * only the wording is this UI's, which is what the seams exist for.
 */
const SUMMARY_LABELS: RouteSummaryLabels = {
  controlPanel: () => t('proxy.target.controlPanel'),
  noUpstream: () => t('proxy.target.noUpstream'),
  noServerPicked: () => t('proxy.target.noServer'),
  fallbackRetry: () => t('proxy.retry.inFallback'),
  retryOne: (count, unit) => tc(`proxy.retry.in${unit === 'minute' ? 'Minutes' : 'Hours'}`, count),
  retryMany: (count, unit) => tc(`proxy.retry.in${unit === 'minute' ? 'Minutes' : 'Hours'}`, count),
}

/** The field messages the shared validator returns, in the reader's language. */
export const ROUTE_ERROR_MESSAGES: RouteErrorMessages = {
  hostRequired: () => t('proxy.validation.hostRequired'),
  hostInvalid: () => t('proxy.validation.hostPattern'),
  hostDuplicate: host => t('proxy.validation.hostTaken', { host }),
  pathNeedsSlash: () => t('proxy.validation.pathSlash'),
  pathHasSpace: () => t('proxy.validation.pathSpace'),
  idInvalid: () => t('proxy.validation.idPattern'),
  idDuplicate: id => t('proxy.validation.idTaken', { id }),
  workspaceRequired: () => t('proxy.validation.workspaceRequired'),
  serverRequired: () => t('proxy.validation.serverRequired'),
  urlInvalid: () => t('proxy.validation.url'),
}

/** What the target column reads: who a route forwards to. */
export function targetSummary(route: ProxyRoute, workspaces: readonly ProxyWorkspace[]): string {
  return sharedTargetSummary(route, workspaces, SUMMARY_LABELS)
}

/** How long until the engine tries the CA again, for the retry confirmation. */
export function retryInLabel(minutes: number | null): string {
  return sharedRetryInLabel(minutes, SUMMARY_LABELS)
}
