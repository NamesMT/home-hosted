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
import type { DdnsView, ProxyPatch, ProxyView, RestorePlan, SessionView, SettingsView, UiStatus, WslTemperatureStatus } from './contracts'
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
  /** Leaf/entry item ids to leave out, applied after `include` — the CLI's `--exclude`. */
  exclude?: string[]
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
    throw new Error(failureMessage(payload, response.status))
  }

  return payload as T
}

/**
 * The sentence a failed request should show, from either error envelope this API uses.
 *
 * There are two, and they are both real: a thrown `DetailedError` answers `{ message, code, detail }`,
 * while a **lifecycle refusal** answers `{ ok: false, error }` — "port 3000 is already in use", "server
 * \"web\" is disabled". Reading only `message` threw the second away and showed
 * `request failed with 409`, which is the one message that tells a person nothing about a start that
 * refused. The CLI has always read `error` first (`src/cli/server.ts`), so the two transports disagreed
 * about the same refusal — the class this module exists to prevent.
 */
export function failureMessage(payload: unknown, status: number): string {
  if (isRecord(payload)) {
    if (typeof payload.message === 'string' && payload.message.length > 0)
      return payload.message
    if (typeof payload.error === 'string' && payload.error.length > 0)
      return payload.error
    // A non-string `error` (an array of validation issues, say) is still better than a bare status.
    if (payload.error !== undefined && payload.error !== null && String(payload.error).length > 0)
      return String(payload.error)
  }
  return `request failed with ${status}`
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

/** What a create may carry: a password, and a selection in either direction. */
export interface CreateBackupOptions {
  password?: string
  /** Leaf ids to capture; omitted means everything. */
  include?: string[]
  /** Leaf ids to leave out, applied after `include`. */
  exclude?: string[]
}

/**
 * The `include`/`exclude` pair as a request body, with an explicitly empty list refused rather than
 * dropped.
 *
 * Omitting `include` means "act on everything" to the server, so a selection of nothing that quietly
 * became no key widened a request into a full archive — and the same for `exclude`, where an empty
 * list left in exactly what was meant to be dropped. Both are mistakes the caller must see, so this
 * is the one place they are turned into an error. Create and restore share it: the CLI refuses the
 * same two shapes, and an empty list is not "no selection" on either verb.
 */
function selectionBody(options: { include?: string[], exclude?: string[] }): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const key of ['include', 'exclude'] as const) {
    const ids = options[key]
    if (ids === undefined)
      continue
    if (ids.length === 0)
      throw new Error(`nothing is ${key === 'include' ? 'selected' : 'excluded'}: omit \`${key}\` or name at least one item`)
    body[key] = ids
  }
  return body
}

/** The create request body: a password, then the selection in either direction. */
export function createBackupBody(options: CreateBackupOptions = {}): Record<string, unknown> {
  const body = selectionBody(options)
  if (options.password !== undefined && options.password.length > 0)
    body.password = options.password
  return body
}

/** The caller re-reads `/api/state` afterwards, which carries the fresh list. */
export function createBackup(options: CreateBackupOptions = {}): Promise<unknown> {
  return request('/api/backups', { method: 'POST', body: JSON.stringify(createBackupBody(options)) })
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

/**
 * The WSL2 temperature bridge: read its state, install it, remove it.
 *
 * A guest has no readable sensor, so these three are what the settings page offers instead of a tile
 * that says `n/a` with no explanation.
 */
export function fetchWslTemperature(): Promise<WslTemperatureStatus> {
  return request<WslTemperatureStatus>('/api/host/temperature')
}

/**
 * Write the helper and point the config at it.
 *
 * `download` is the person's consent to fetch LibreHardwareMonitor: without it the panel answers
 * `needsDownload` and writes nothing but the helper, so no click installs a binary it did not mention.
 */
export function installWslTemperature(options: { download?: boolean } = {}): Promise<WslTemperatureStatus> {
  const query = options.download === true ? '?download=true' : ''
  return request<WslTemperatureStatus>(`/api/host/temperature${query}`, { method: 'POST' })
}

export function removeWslTemperature(): Promise<WslTemperatureStatus> {
  return request<WslTemperatureStatus>('/api/host/temperature', { method: 'DELETE' })
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

/**
 * The restore request body — the same pair the CLI's `backup restore … --exclude …` sends.
 *
 * It went through its own copy that carried only `password` and `include`, so a UI could tick items
 * but never say "everything except these": the one shape the docs recommend for a shared archive.
 */
export function restoreBody(options: RestoreOptions): Record<string, unknown> {
  const body = selectionBody(options)
  if (options.password !== undefined && options.password.length > 0)
    body.password = options.password
  return body
}

export function restoreStoredBackup(name: string, confirm: boolean, options: RestoreOptions = {}): Promise<RestorePlan> {
  return request<RestorePlan>(`/api/backups/restore?confirm=${confirm}`, {
    method: 'POST',
    body: JSON.stringify({ name, ...restoreBody(options) }),
  })
}

/**
 * A restore from a file the person picked, which cannot travel as JSON.
 *
 * A multipart body can only carry strings, so each selection is JSON — the server parses both
 * fields the same way. This was a byte-identical copy in each UI's `lib/api.ts` (and each had its
 * own `RestoreOptions` beside it), so the pair could only ever be extended in one of them: exactly
 * what happened when `exclude` arrived on the create side.
 */
export async function restoreUploadedBackup(file: File, confirm: boolean, options: RestoreOptions = {}): Promise<RestorePlan> {
  const form = new FormData()
  form.append('file', file)
  for (const [key, value] of Object.entries(restoreBody(options))) {
    form.append(key, key === 'password' ? String(value) : JSON.stringify(value))
  }

  const response = await fetch(`/api/backups/restore?confirm=${confirm}`, { method: 'POST', body: form })
  const payload = await response.json().catch(() => null) as (RestorePlan & { message?: string }) | null
  if (!response.ok)
    // The API's one error envelope is `{ message, code, detail }`; reading `error` showed every
    // failure here as "restore failed with 400". `error` stays as a fallback because a successful
    // `RestorePlan` carries its own refusal reason there.
    throw new Error(payload?.message ?? payload?.error ?? `restore failed with ${response.status}`)
  return payload as RestorePlan
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
