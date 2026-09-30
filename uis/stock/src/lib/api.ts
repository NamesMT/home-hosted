import type {
  AppState,
  BackupsView,
  DdnsConfig,
  DdnsView,
  FreePortResult,
  LogHistoryView,
  LogServerView,
  ProxyPatch,
  ProxyView,
  RestorePlan,
  ServerCreate,
  ServerPatch,
  ServerView,
  SessionView,
  SettingsPatch,
  SettingsSaved,
  SettingsView,
  UiStatus,
  WorkspaceCreate,
  WorkspaceSettingsPatch,
  WorkspaceSettingsView,
  WorkspaceView,
} from '@shared/contracts'
import {
  appStateSchema,
  ddnsViewSchema,
  logHistoryViewSchema,
  loginSchema,
  logServersViewSchema,
  passwordSchema,
  proxyCertificateUploadSchema,
  proxyPatchSchema,
  proxyViewSchema,
  settingsPatchSchema,
  workspaceSettingsPatchSchema,
  workspaceSettingsViewSchema,
  workspaceViewSchema,
} from '@shared/contracts'
import { type } from 'arktype'
import { rpc } from '@/lib/rpc'

export type { BackupFile, BackupsView, ProxyView, RestoreItem, RestorePlan, SettingsView, UiStatus, WorkspaceSettingsView, WorkspaceView } from '@shared/contracts'

/**
 * The schema accepts a request-shaped `port` (possibly absent); the panel always
 * emits the normalized `number | null` form. These view types carry that one
 * narrowing through the whole UI.
 */
export type WorkspaceState = Omit<WorkspaceView, 'servers'> & { servers: ServerView[] }
export type AppStateView = Omit<AppState, 'workspaces'> & { workspaces: WorkspaceState[] }

export interface ActionResult {
  ok: boolean
  error?: string
}

/** `GET /api/workspaces` and the single-workspace CRUD answers. */
const workspacesViewSchema = type({ workspaces: workspaceViewSchema.array() })
const workspaceAnswerSchema = type({ workspace: workspaceViewSchema })
const workspaceRemovedSchema = type({ ok: 'boolean', removed: 'unknown' })

export interface LogServerInfo extends LogServerView {}

export interface LogQuery {
  tail?: number
  search?: string
  stream?: string
}

export interface RestoreOptions {
  password?: string
  /** Leaf/entry item ids to restore; omitted means every restorable item. */
  include?: string[]
}

export interface WorkspaceRemoved {
  ok: boolean
  removed: unknown
}

/** Raised when the control plane wants a login before it will answer. */
export class AuthRequiredError extends Error {
  override name = 'AuthRequiredError'

  constructor() {
    super('authentication required')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** One `?workspace=<id>` qualifier; omitted lets the panel pick its default. */
export function workspaceQuery(workspace?: string | null): string {
  return workspace === undefined || workspace === null || workspace.length === 0
    ? ''
    : `?workspace=${encodeURIComponent(workspace)}`
}

/** The typed RPC arguments for a workspace-scoped server route; empty means "default". */
function rpcArgs(workspace: string, id: string): { param: { id: string }, query: { workspace?: string } } {
  return { param: { id }, query: workspace.length > 0 ? { workspace } : {} }
}

function scoped(path: string, workspace: string, extra?: URLSearchParams): string {
  const params = extra ?? new URLSearchParams()
  if (workspace.length > 0)
    params.set('workspace', workspace)
  const query = params.toString()
  return query.length > 0 ? `${path}?${query}` : path
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
export async function fetchState(): Promise<AppStateView> {
  const payload = await request<unknown>('/api/state')
  const parsed = appStateSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`state contract mismatch: ${parsed.summary}`)
  // The schema accepts both `port` forms; the control plane always sends the
  // normalized one (`number | null`), which is what AppStateView describes.
  return parsed as AppStateView
}

export function fetchSession(): Promise<SessionView> {
  return request<SessionView>('/api/auth/session')
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

export function setPassword(currentPassword: string | undefined, newPassword: string): Promise<{ ok: boolean, enabled: boolean }> {
  // ArkType treats an explicit `undefined` as an invalid string, so the key is
  // omitted entirely when there is no current password (first-time setup).
  const body = currentPassword === undefined ? { newPassword } : { currentPassword, newPassword }
  const parsed = passwordSchema(body)
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return request('/api/auth/password', { method: 'POST', body: JSON.stringify(parsed) })
}

export function clearPassword(): Promise<unknown> {
  return request('/api/auth/password', { method: 'DELETE' })
}

/** Every workspace the panel serves, in panel order; the first is the default. */
export async function fetchWorkspaces(): Promise<WorkspaceState[]> {
  const payload = await request<unknown>('/api/workspaces')
  const parsed = workspacesViewSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`workspaces contract mismatch: ${parsed.summary}`)
  return parsed.workspaces as WorkspaceState[]
}

async function workspaceAnswer(payload: unknown): Promise<WorkspaceState> {
  const parsed = workspaceAnswerSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`workspace contract mismatch: ${parsed.summary}`)
  return parsed.workspace as WorkspaceState
}

export async function createWorkspace(input: WorkspaceCreate): Promise<WorkspaceState> {
  return workspaceAnswer(await request<unknown>('/api/workspaces', { method: 'POST', body: JSON.stringify(input) }))
}

export async function renameWorkspace(id: string, label: string): Promise<WorkspaceState> {
  return workspaceAnswer(await request<unknown>(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ label }),
  }))
}

export async function deleteWorkspace(id: string): Promise<WorkspaceRemoved> {
  const payload = await request<unknown>(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' })
  const parsed = workspaceRemovedSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`workspace removal contract mismatch: ${parsed.summary}`)
  return parsed as WorkspaceRemoved
}

/** `GET /api/settings`: the panel-wide configuration (listener, auth, host, backups, UI). */
export function fetchSettings(): Promise<SettingsView> {
  return request<SettingsView>('/api/settings')
}

export function patchSettings(patch: SettingsPatch): Promise<SettingsSaved> {
  const parsed = settingsPatchSchema(patch)
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return request<SettingsSaved>('/api/settings', { method: 'PATCH', body: JSON.stringify(parsed) })
}

/** `GET /api/settings/workspace?workspace=<id>`: defaults, logs and notifications. */
export async function fetchWorkspaceSettings(workspace: string): Promise<WorkspaceSettingsView> {
  const payload = await request<unknown>(scoped('/api/settings/workspace', workspace))
  const parsed = workspaceSettingsViewSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`workspace settings contract mismatch: ${parsed.summary}`)
  return parsed as WorkspaceSettingsView
}

export async function patchWorkspaceSettings(workspace: string, patch: WorkspaceSettingsPatch): Promise<WorkspaceSettingsView> {
  const parsed = workspaceSettingsPatchSchema(patch)
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  const payload = await request<unknown>(scoped('/api/settings/workspace', workspace), {
    method: 'PATCH',
    body: JSON.stringify(parsed),
  })
  const view = workspaceSettingsViewSchema(payload)
  if (view instanceof type.errors)
    throw new Error(`workspace settings contract mismatch: ${view.summary}`)
  return view as WorkspaceSettingsView
}

export async function fetchLogServers(workspace: string): Promise<LogServerInfo[]> {
  const payload = await request<unknown>(scoped('/api/logs', workspace))
  const parsed = logServersViewSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`logs contract mismatch: ${parsed.summary}`)
  return parsed.servers as LogServerInfo[]
}

export async function fetchLogHistory(workspace: string, id: string, query: LogQuery): Promise<LogHistoryView> {
  const params = new URLSearchParams()
  if (query.tail !== undefined)
    params.set('tail', String(query.tail))
  if (query.search !== undefined && query.search.length > 0)
    params.set('search', query.search)
  if (query.stream !== undefined && query.stream.length > 0)
    params.set('stream', query.stream)

  const payload = await request<unknown>(scoped(`/api/logs/${encodeURIComponent(id)}`, workspace, params))
  const parsed = logHistoryViewSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`log history contract mismatch: ${parsed.summary}`)
  return parsed as LogHistoryView
}

export function clearLogHistory(workspace: string, id: string): Promise<unknown> {
  return request(scoped(`/api/logs/${encodeURIComponent(id)}`, workspace), { method: 'DELETE' })
}

/** Direct link; the session cookie is sent by the browser. */
export function logDownloadUrl(workspace: string, id: string, file: string): string {
  return scoped(`/api/logs/${encodeURIComponent(id)}/download`, workspace, new URLSearchParams({ file }))
}

/** Backups are panel-wide: every workspace is a selectable entry in the archive. */
export function fetchBackups(): Promise<BackupsView> {
  return request<BackupsView>('/api/backups')
}

/**
 * The caller re-reads `/api/state` afterwards, which carries the fresh list.
 * An explicitly empty `include` is refused rather than dropped: omitting the key
 * means "capture everything" to the server, so silently widening a selection of
 * nothing into a full archive is the one outcome that must never happen.
 */
export function createBackup(password?: string, include?: string[]): Promise<unknown> {
  if (include !== undefined && include.length === 0)
    throw new Error('nothing is selected: omit `include` to capture everything, or select at least one item')

  const body: Record<string, unknown> = {}
  if (password !== undefined && password.length > 0)
    body.password = password
  if (include !== undefined)
    body.include = include
  return request('/api/backups', { method: 'POST', body: JSON.stringify(body) })
}

export function deleteBackup(name: string): Promise<unknown> {
  return request(`/api/backups/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

export function backupDownloadUrl(name: string): string {
  return `/api/backups/${encodeURIComponent(name)}/download`
}

function restoreBody(options: RestoreOptions): Record<string, unknown> {
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

export async function restoreUploadedBackup(file: File, confirm: boolean, options: RestoreOptions = {}): Promise<RestorePlan> {
  const form = new FormData()
  form.append('file', file)
  // Multipart fields are strings, so the selection travels as JSON.
  if (options.password !== undefined && options.password.length > 0)
    form.append('password', options.password)
  if (options.include !== undefined)
    form.append('include', JSON.stringify(options.include))

  const response = await fetch(`/api/backups/restore?confirm=${confirm}`, { method: 'POST', body: form })
  const payload = await response.json().catch(() => null) as RestorePlan | null
  if (!response.ok)
    throw new Error(payload?.error ?? `restore failed with ${response.status}`)
  return payload as RestorePlan
}

export function saveTelegramToken(workspace: string, botToken: string): Promise<{ ok: boolean, username: string | null }> {
  return request(scoped('/api/notifications/token', workspace), { method: 'PUT', body: JSON.stringify({ botToken }) })
}

export function clearTelegramToken(workspace: string): Promise<unknown> {
  return request(scoped('/api/notifications/token', workspace), { method: 'DELETE' })
}

export function sendTelegramTest(workspace: string, payload: { botToken?: string, chatId?: string }): Promise<{ ok: boolean, error?: string }> {
  return request(scoped('/api/notifications/test', workspace), { method: 'POST', body: JSON.stringify(payload) })
}

export function detectTelegramChats(workspace: string, payload: { botToken?: string }): Promise<{ chats: Array<{ id: number | string, title: string }> }> {
  return request(scoped('/api/notifications/detect-chats', workspace), { method: 'POST', body: JSON.stringify(payload) })
}

/** Dynamic DNS, validated at the boundary like the rest of the settings payloads. */
async function ddnsView(payload: unknown): Promise<DdnsView> {
  const parsed = ddnsViewSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`ddns contract mismatch: ${parsed.summary}`)
  return parsed as DdnsView
}

export async function fetchDdns(workspace: string): Promise<DdnsView> {
  return ddnsView(await request<unknown>(scoped('/api/ddns', workspace)))
}

export async function saveDdns(workspace: string, config: DdnsConfig): Promise<DdnsView> {
  return ddnsView(await request<unknown>(scoped('/api/ddns', workspace), { method: 'PUT', body: JSON.stringify(config) }))
}

/** The provider travels with the request: the account may still be an unsaved draft. */
export async function saveDdnsCredentials(workspace: string, id: string, provider: string, credentials: Record<string, string>): Promise<DdnsView> {
  return ddnsView(await request<unknown>(scoped(`/api/ddns/credentials/${encodeURIComponent(id)}`, workspace), {
    method: 'PUT',
    body: JSON.stringify({ provider, credentials }),
  }))
}

export async function clearDdnsCredentials(workspace: string, id: string): Promise<DdnsView> {
  return ddnsView(await request<unknown>(scoped(`/api/ddns/credentials/${encodeURIComponent(id)}`, workspace), { method: 'DELETE' }))
}

/** Runs a pass now; the answer carries the fresh status. */
export async function checkDdns(workspace: string): Promise<DdnsView> {
  return ddnsView(await request<unknown>(scoped('/api/ddns/check', workspace), { method: 'POST' }))
}

/** Replace the panel UI with a static build (a zip); the next refresh shows it. */
export async function uploadUi(file: File): Promise<{ ok: boolean, meta: UiStatus['meta'], ui: UiStatus }> {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch('/api/settings/ui', { method: 'POST', body: form })
  const payload = await response.json().catch(() => null) as { message?: string, error?: string } | null
  if (!response.ok)
    throw new Error(payload?.message ?? payload?.error ?? `the upload failed with ${response.status}`)
  return payload as { ok: boolean, meta: UiStatus['meta'], ui: UiStatus }
}

/** Back to the stock UI. */
export function revertUi(): Promise<{ ok: boolean, removed: boolean, ui: UiStatus }> {
  return request('/api/settings/ui', { method: 'DELETE' })
}

export function uploadTls(certificate: string, privateKey: string): Promise<SettingsSaved> {
  return request<SettingsSaved>('/api/settings/tls', { method: 'POST', body: JSON.stringify({ certificate, privateKey }) })
}

export function clearTls(): Promise<SettingsSaved> {
  return request<SettingsSaved>('/api/settings/tls', { method: 'DELETE' })
}

/** The reverse proxy is panel-wide: one engine, one route table, one set of ports. */
async function proxyView(payload: unknown): Promise<ProxyView> {
  const parsed = proxyViewSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`proxy contract mismatch: ${parsed.summary}`)
  return parsed as ProxyView
}

export async function fetchProxy(): Promise<ProxyView> {
  return proxyView(await request<unknown>('/api/proxy'))
}

export async function patchProxy(patch: ProxyPatch): Promise<ProxyView> {
  const parsed = proxyPatchSchema(patch)
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return proxyView(await request<unknown>('/api/proxy', { method: 'PATCH', body: JSON.stringify(parsed) }))
}

/** Empty version installs the pinned release; a version pins another one. */
export async function installProxyEngine(version = ''): Promise<ProxyView> {
  return proxyView(await request<unknown>('/api/proxy/engine', { method: 'POST', body: JSON.stringify({ version }) }))
}

function proxyAction(action: 'start' | 'stop' | 'apply' | 'revert'): Promise<ProxyView> {
  return request<unknown>(`/api/proxy/${action}`, { method: 'POST' }).then(proxyView)
}

export function startProxy(): Promise<ProxyView> {
  return proxyAction('start')
}

export function stopProxy(): Promise<ProxyView> {
  return proxyAction('stop')
}

export function applyProxy(): Promise<ProxyView> {
  return proxyAction('apply')
}

export function revertProxy(): Promise<ProxyView> {
  return proxyAction('revert')
}

/**
 * One uploaded pair, stored under an id that also names its files on disk. The
 * entry joins the config, so this is the write — there is no separate Save.
 */
export async function uploadProxyCertificate(id: string, label: string, certificate: string, privateKey: string): Promise<ProxyView> {
  const body = proxyCertificateUploadSchema({ label, certificate, privateKey })
  if (body instanceof type.errors)
    throw new Error(body.summary)
  return proxyView(await request<unknown>(`/api/proxy/certificates/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }))
}

/** Refused with `PROXY_TLS_IN_USE` while a route still serves the pair. */
export async function clearProxyCertificate(id: string): Promise<ProxyView> {
  return proxyView(await request<unknown>(`/api/proxy/certificates/${encodeURIComponent(id)}`, { method: 'DELETE' }))
}

/**
 * Lifecycle calls go through the typed RPC client: the route, its parameter and
 * the result shape are inferred from the server app, so a renamed route or a
 * changed DTO fails the build instead of the click. An empty workspace id is
 * omitted so the panel resolves its own default.
 */
export async function serverAction(workspace: string, id: string, action: 'start' | 'stop' | 'restart'): Promise<ActionResult> {
  const response = await rpc.api.servers[':id'][action].$post(rpcArgs(workspace, id))
  const payload = await response.json().catch(() => null) as (ActionResult & { message?: string }) | null
  if (!response.ok)
    throw new Error(payload?.message ?? `request failed with ${response.status}`)
  return payload ?? { ok: true }
}

export function startAll(workspace: string): Promise<unknown> {
  return request(scoped('/api/servers/start-all', workspace), { method: 'POST' })
}

/**
 * Frees a server's port by asking the listener holding it to stop. The server
 * re-lists the holders itself, so this never kills a pid quoted in an old banner.
 */
export async function freePort(workspace: string, id: string): Promise<FreePortResult> {
  const response = await rpc.api.servers[':id']['free-port'].$post(rpcArgs(workspace, id))
  const payload = await response.json().catch(() => null) as (FreePortResult & { message?: string }) | null
  if (!response.ok)
    throw new Error(payload?.message ?? `request failed with ${response.status}`)
  return payload ?? { ok: true, port: null, terminated: [], forced: [], skipped: [], free: false }
}

export function stopAll(workspace: string): Promise<unknown> {
  return request(scoped('/api/servers/stop-all', workspace), { method: 'POST' })
}

export function clearLogs(workspace: string, id: string): Promise<unknown> {
  return request(scoped(`/api/servers/${encodeURIComponent(id)}/clear-logs`, workspace), { method: 'POST' })
}

export type ServerPatchPayload = Partial<ServerPatch> & Record<string, unknown>

export function patchServer(workspace: string, id: string, patch: ServerPatchPayload): Promise<unknown> {
  return request(scoped(`/api/servers/${encodeURIComponent(id)}`, workspace), {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function removeServer(workspace: string, id: string): Promise<unknown> {
  return request(scoped(`/api/servers/${encodeURIComponent(id)}`, workspace), { method: 'DELETE' })
}

/** The create body is exactly the strict, defaulted schema the route validates. */
export type CreateServerPayload = ServerCreate

export function createServer(workspace: string, payload: CreateServerPayload): Promise<unknown> {
  return request(scoped('/api/servers', workspace), { method: 'POST', body: JSON.stringify(payload) })
}
