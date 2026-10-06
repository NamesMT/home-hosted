import type {
  AppState,
  BackupsView,
  DdnsConfig,
  DdnsView,
  FreePortResult,
  LogHistoryView,
  LogServerView,
  RestorePlan,
  ServerCreate,
  ServerPatch,
  ServerView,
  SettingsPatch,
  SettingsSaved,
  WorkspaceCreate,
  WorkspaceSettingsPatch,
  WorkspaceSettingsView,
  WorkspaceView,
} from '@shared/contracts'
// The calls and helpers both UIs make identically now live in `src/shared/api-client.ts`.
// Imported (not only re-exported) because this file's workspace-scoped wrappers call them: a
// re-export does not bring a name into this module's scope.
import {
  ddnsView,
  request,
} from '@shared/api-client'
import {
  appStateSchema,
  logHistoryViewSchema,
  logServersViewSchema,
  settingsPatchSchema,
  workspaceSettingsPatchSchema,
  workspaceSettingsViewSchema,
  workspaceViewSchema,
} from '@shared/contracts'
import { type } from 'arktype'

import { rpc } from '@/lib/rpc'

export { AuthRequiredError } from '@shared/api-client'
export {
  applyProxy,
  backupDownloadUrl,
  clearPassword,
  clearProxyCertificate,
  deleteBackup,
  fetchProxy,
  fetchSession,
  fetchSettings,
  installProxyEngine,
  login,
  logout,
  patchProxy,
  restoreStoredBackup,
  retryProxyCertificate,
  revertProxy,
  revertUi,
  setPassword,
  startProxy,
  stopProxy,
  uploadProxyCertificate,
  uploadUi,
} from '@shared/api-client'

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

export async function restoreUploadedBackup(file: File, confirm: boolean, options: RestoreOptions = {}): Promise<RestorePlan> {
  const form = new FormData()
  form.append('file', file)
  // Multipart fields are strings, so the selection travels as JSON.
  if (options.password !== undefined && options.password.length > 0)
    form.append('password', options.password)
  if (options.include !== undefined)
    form.append('include', JSON.stringify(options.include))

  const response = await fetch(`/api/backups/restore?confirm=${confirm}`, { method: 'POST', body: form })
  const payload = await response.json().catch(() => null) as (RestorePlan & { message?: string }) | null
  if (!response.ok) {
    // The API's one error envelope is `{ message, code, detail }`; reading `error`
    // showed every failure here as "restore failed with 400". `error` stays as a
    // fallback because a successful `RestorePlan` carries its own refusal reason there.
    throw new Error(payload?.message ?? payload?.error ?? `restore failed with ${response.status}`)
  }
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

export function uploadTls(certificate: string, privateKey: string): Promise<SettingsSaved> {
  return request<SettingsSaved>('/api/settings/tls', { method: 'POST', body: JSON.stringify({ certificate, privateKey }) })
}

export function clearTls(): Promise<SettingsSaved> {
  return request<SettingsSaved>('/api/settings/tls', { method: 'DELETE' })
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
