/**
 * The panel API calls both UIs make identically, with the helpers they build on.
 *
 * These were byte-identical copies in `uis/stock/src/lib/api.ts` and `uis/noc-console/src/lib/api.ts` —
 * the duplication class `proxy-form.ts` was created for, and one that has already drifted twice: the
 * `request` helper read a bare `error` field in one UI and not the other, so the same failed call
 * reported different text depending on where you were.
 *
 * Every dependency here is already in `src/shared`, so this module imports nothing upward — the
 * constraint that keeps `rpc.ts` and the `ddns`/`proxy` helpers in the UIs, which import Vue.
 *
 * **Deliberately not here:** the workspace-scoped wrappers. Each UI spells that differently —
 * `noc-console` reads a reactive `selectedWorkspaceId`, `stock` takes an explicit argument — so their
 * `scoped()` differs and the calls that use it stay in the UI.
 */
import type { DdnsView, ProxyPatch, ProxyView, RestorePlan, SessionView, SettingsView, UiStatus } from './contracts'
import { type } from 'arktype'
import { ddnsViewSchema, loginSchema, passwordSchema, proxyCertificateUploadSchema, proxyPatchSchema, proxyViewSchema } from './contracts'
import { isRecord } from './shape'

/** Thrown on a 401 with `code: "AUTH_REQUIRED"`, so the SPA can route to the login view. */
export class AuthRequiredError extends Error {
  override name = 'AuthRequiredError'

  constructor() {
    super('authentication required')
  }
}

/**
 * What a restore may carry. Identical in both UIs apart from one doc comment; the fuller wording is
 * kept.
 */
export interface RestoreOptions {
  password?: string
  /** Leaf/entry item ids to restore; omitted means every restorable item. */
  include?: string[]
}

/**
 * One JSON request, with the panel's error envelope turned into an `Error`.
 *
 * Reads `message` first, then a bare `error` field. The two UIs disagreed on that fallback until it was
 * aligned, and this is the one place it now lives.
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })

  const text = await response.text()
  const payload: unknown = text.length > 0 ? JSON.parse(text) : null

  if (!response.ok) {
    if (response.status === 401 && isRecord(payload) && payload.code === 'AUTH_REQUIRED')
      throw new AuthRequiredError()
    const message = isRecord(payload) && typeof payload.message === 'string'
      ? payload.message
      : isRecord(payload) && 'error' in payload
        ? String(payload.error)
        : `request failed with ${response.status}`
    throw new Error(message)
  }

  return payload as T
}

/** Validated at the boundary: contract drift fails loudly here, not in the UI. */
export async function proxyView(payload: unknown): Promise<ProxyView> {
  const parsed = proxyViewSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`proxy contract mismatch: ${parsed.summary}`)
  return parsed as ProxyView
}

export async function ddnsView(payload: unknown): Promise<DdnsView> {
  const parsed = ddnsViewSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`ddns contract mismatch: ${parsed.summary}`)
  return parsed as DdnsView
}

export function proxyAction(action: 'start' | 'stop' | 'apply' | 'revert'): Promise<ProxyView> {
  return request<unknown>(`/api/proxy/${action}`, { method: 'POST' }).then(proxyView)
}

export function applyProxy(): Promise<ProxyView> {
  return proxyAction('apply')
}

export function backupDownloadUrl(name: string): string {
  return `/api/backups/${encodeURIComponent(name)}/download`
}

export function clearPassword(): Promise<unknown> {
  return request('/api/auth/password', { method: 'DELETE' })
}

export async function clearProxyCertificate(id: string): Promise<ProxyView> {
  return proxyView(await request<unknown>(`/api/proxy/certificates/${encodeURIComponent(id)}`, { method: 'DELETE' }))
}

export function deleteBackup(name: string): Promise<unknown> {
  return request(`/api/backups/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

export async function fetchProxy(): Promise<ProxyView> {
  return proxyView(await request<unknown>('/api/proxy'))
}

export function fetchSession(): Promise<SessionView> {
  return request<SessionView>('/api/auth/session')
}

export function fetchSettings(): Promise<SettingsView> {
  return request<SettingsView>('/api/settings')
}

export async function installProxyEngine(version = ''): Promise<ProxyView> {
  return proxyView(await request<unknown>('/api/proxy/engine', { method: 'POST', body: JSON.stringify({ version }) }))
}

export function login(password: string): Promise<SessionView> {
  const parsed = loginSchema({ password })
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return request<SessionView>('/api/auth/login', { method: 'POST', body: JSON.stringify(parsed) })
}

export function logout(): Promise<unknown> {
  return request('/api/auth/logout', { method: 'POST' })
}

export async function patchProxy(patch: ProxyPatch): Promise<ProxyView> {
  const parsed = proxyPatchSchema(patch)
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return proxyView(await request<unknown>('/api/proxy', { method: 'PATCH', body: JSON.stringify(parsed) }))
}

export function restoreBody(options: RestoreOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (options.password !== undefined && options.password.length > 0)
    body.password = options.password
  if (options.include !== undefined)
    body.include = options.include
  return body
}

export function restoreStoredBackup(name: string, confirm: boolean, options: RestoreOptions = {}): Promise<RestorePlan> {
  return request<RestorePlan>(`/api/backups/restore?confirm=${confirm}`, {
    method: 'POST',
    body: JSON.stringify({ name, ...restoreBody(options) }),
  })
}

export async function retryProxyCertificate(id: string): Promise<ProxyView> {
  return proxyView(await request<unknown>(`/api/proxy/routes/${encodeURIComponent(id)}/retry-certificate`, { method: 'POST' }))
}

export function revertProxy(): Promise<ProxyView> {
  return proxyAction('revert')
}

export function revertUi(): Promise<{ ok: boolean, removed: boolean, ui: UiStatus }> {
  return request('/api/settings/ui', { method: 'DELETE' })
}

export function setPassword(currentPassword: string | undefined, newPassword: string): Promise<{ ok: boolean, enabled: boolean }> {
  // ArkType treats an explicit `undefined` as an invalid string, so the key is
  // omitted entirely when there is no current password (first-time setup).
  const body = currentPassword === undefined ? { newPassword } : { currentPassword, newPassword }
  const parsed = passwordSchema(body)
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return request('/api/auth/password', { method: 'POST', body: JSON.stringify(parsed) })
}

export function startProxy(): Promise<ProxyView> {
  return proxyAction('start')
}

export function stopProxy(): Promise<ProxyView> {
  return proxyAction('stop')
}

export async function uploadProxyCertificate(id: string, label: string, certificate: string, privateKey: string): Promise<ProxyView> {
  const body = proxyCertificateUploadSchema({ label, certificate, privateKey })
  if (body instanceof type.errors)
    throw new Error(body.summary)
  return proxyView(await request<unknown>(`/api/proxy/certificates/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }))
}

export async function uploadUi(file: File): Promise<{ ok: boolean, meta: UiStatus['meta'], ui: UiStatus }> {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch('/api/settings/ui', { method: 'POST', body: form })
  const payload = await response.json().catch(() => null) as { message?: string, error?: string } | null
  if (!response.ok)
    throw new Error(payload?.message ?? payload?.error ?? `the upload failed with ${response.status}`)
  return payload as { ok: boolean, meta: UiStatus['meta'], ui: UiStatus }
}
