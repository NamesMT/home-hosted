import type {
  AppState,
  BackupEntry,
  BackupFile,
  BackupsView,
  DdnsConfig,
  DdnsView,
  LogHistoryView,
  LogServerView,
  RestorePlan,
  ServerCreate,
  ServerPatch,
  SettingsPatch,
  SettingsView,
  UiMeta,
  WorkspaceCreate,
  WorkspaceSettingsPatch,
  WorkspaceSettingsView,
  WorkspaceView,
} from '@shared/contracts'
// The calls and helpers both UIs make identically now live in `src/shared/api-client.ts`. Imported
// (not only re-exported) because this file's workspace-scoped wrappers call them.
import {
  ddnsView,
  request,
} from '@shared/api-client'
import {
  appStateSchema,
  backupsViewSchema,
  logHistoryViewSchema,
  logServersViewSchema,
  settingsPatchSchema,
  settingsSavedSchema,
  workspaceCreateSchema,
  workspaceRenameSchema,
  workspaceSettingsPatchSchema,
  workspaceSettingsSavedSchema,
  workspaceSettingsViewSchema,
  workspaceViewSchema,
} from '@shared/contracts'
import { type } from 'arktype'

import { selectedWorkspaceId } from '@/lib/selection'

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

export type {
  BackupEntry,
  BackupFile,
  BackupsView,
  RestorePlan,
  SettingsView,
}

/**
 * The installed UI's identity. The contract keeps every field optional (a
 * hand-written `ui.json` has no `uploadedAt`/`files`); a panel that installs one
 * always fills them in, and the settings page reads them as present.
 */
export interface UiStatus {
  custom: boolean
  dir: string
  meta: (UiMeta & { name: string, version: string | null, uploadedAt: number, files: number }) | null
}

export interface ActionResult {
  ok: boolean
  error?: string
}

/** `GET /api/settings/workspace`: what the pinned workspace owns on its own. */
export type WorkspaceSettings = WorkspaceSettingsView

export interface LogServerInfo extends LogServerView {}

export interface LogQuery {
  tail?: number
  search?: string
  stream?: string
}

/** A data path a backup would capture, flattened out of the entry tree. */
export interface BackupPathEntry {
  path: string
  /** Which leaf this path is in a backup's `include`; older panels omit it. */
  id?: string
  origin: string
  included: boolean
  note: string | null
}

export interface RestoreOptions {
  password?: string
  /** Item ids to restore; omitted means every restorable item. */
  include?: string[]
}

export interface SettingsSaveResult extends SettingsView {
  /** The listener is being moved; wait for `targetUrl` before redirecting. */
  rebinding: boolean
  /** The address the panel is moving to, or null when it stays put. */
  targetUrl: string | null
}

/**
 * Every server, log, DDNS and notification route is workspace-scoped; omitting
 * the parameter means the panel's own default workspace. The shell keeps the
 * selected workspace in `selectedWorkspaceId`, so the scoped calls default to it.
 */
function scoped(path: string, workspace?: string | null): string {
  const id = workspace ?? selectedWorkspaceId.value
  if (id === null || id === undefined || id.length === 0)
    return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}workspace=${encodeURIComponent(id)}`
}

/** Appends the workspace to a URLSearchParams body for the streaming routes. */
function scopedParams(workspace?: string | null): URLSearchParams {
  const params = new URLSearchParams()
  const id = workspace ?? selectedWorkspaceId.value
  if (id !== null && id !== undefined && id.length > 0)
    params.set('workspace', id)
  return params
}

/** The per-server event stream URL, workspace-scoped like every other route. */
export function serverStreamUrl(id: string, workspace?: string | null): string {
  return scoped(`/api/servers/${encodeURIComponent(id)}/stream`, workspace)
}

/** Validated at the boundary: contract drift fails loudly here, not in the UI. */
export async function fetchState(): Promise<AppState> {
  const payload = await request<unknown>('/api/state')
  const parsed = appStateSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`state contract mismatch: ${parsed.summary}`)
  // The schema accepts both `port` forms; the control plane always sends the
  // normalized one (`number | null`), which is what AppState describes.
  return parsed as AppState
}

/** Writes the panel-wide groups; `defaults`/`logs`/`notifications` go to the workspace route. */
export async function patchSettings(patch: SettingsPatch): Promise<SettingsSaveResult> {
  const parsed = settingsPatchSchema(patch)
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  const payload = await request<unknown>('/api/settings', { method: 'PATCH', body: JSON.stringify(parsed) })
  const saved = settingsSavedSchema(payload)
  if (saved instanceof type.errors)
    throw new Error(`settings contract mismatch: ${saved.summary}`)
  return saved as SettingsSaveResult
}

/** One workspace's own settings, validated at the boundary like the global ones. */
export async function fetchWorkspaceSettings(workspace?: string | null): Promise<WorkspaceSettings> {
  const payload = await request<unknown>(scoped('/api/settings/workspace', workspace))
  const parsed = workspaceSettingsViewSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`workspace settings contract mismatch: ${parsed.summary}`)
  return parsed as WorkspaceSettings
}

export async function patchWorkspaceSettings(patch: WorkspaceSettingsPatch, workspace?: string | null): Promise<WorkspaceSettings> {
  const parsed = workspaceSettingsPatchSchema(patch)
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  const payload = await request<unknown>(scoped('/api/settings/workspace', workspace), {
    method: 'PATCH',
    body: JSON.stringify(parsed),
  })
  const saved = workspaceSettingsSavedSchema(payload)
  if (saved instanceof type.errors)
    throw new Error(`workspace settings contract mismatch: ${saved.summary}`)
  return saved as WorkspaceSettings
}

async function workspaceView(payload: unknown): Promise<WorkspaceView> {
  const parsed = workspaceViewSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`workspace contract mismatch: ${parsed.summary}`)
  return parsed as WorkspaceView
}

export async function createWorkspace(payload: WorkspaceCreate = {}): Promise<WorkspaceView> {
  const parsed = workspaceCreateSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  const response = await request<unknown>('/api/workspaces', { method: 'POST', body: JSON.stringify(parsed) })
  return workspaceView((response as { workspace?: unknown } | null)?.workspace)
}

export async function renameWorkspace(id: string, label: string): Promise<WorkspaceView> {
  const parsed = workspaceRenameSchema({ label })
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  const response = await request<unknown>(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(parsed),
  })
  return workspaceView((response as { workspace?: unknown } | null)?.workspace)
}

export function removeWorkspace(id: string): Promise<{ ok: boolean, removed: { id: string, label: string } }> {
  return request(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function fetchLogServers(workspace?: string | null): Promise<LogServerInfo[]> {
  const payload = await request<unknown>(scoped('/api/logs', workspace))
  const parsed = logServersViewSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`logs contract mismatch: ${parsed.summary}`)
  return parsed.servers as LogServerInfo[]
}

export async function fetchLogHistory(id: string, query: LogQuery, workspace?: string | null): Promise<LogHistoryView> {
  const params = scopedParams(workspace)
  if (query.tail !== undefined)
    params.set('tail', String(query.tail))
  if (query.search !== undefined && query.search.length > 0)
    params.set('search', query.search)
  if (query.stream !== undefined && query.stream.length > 0)
    params.set('stream', query.stream)

  const payload = await request<unknown>(`/api/logs/${encodeURIComponent(id)}?${params.toString()}`)
  const parsed = logHistoryViewSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`log history contract mismatch: ${parsed.summary}`)
  return parsed as LogHistoryView
}

export function clearLogHistory(id: string, workspace?: string | null): Promise<unknown> {
  return request(scoped(`/api/logs/${encodeURIComponent(id)}`, workspace), { method: 'DELETE' })
}

/** Direct link; the session cookie is sent by the browser. */
export function logDownloadUrl(id: string, file: string, workspace?: string | null): string {
  return scoped(`/api/logs/${encodeURIComponent(id)}/download?file=${encodeURIComponent(file)}`, workspace)
}

export async function fetchBackups(): Promise<BackupsView> {
  const payload = await request<unknown>('/api/backups')
  const parsed = backupsViewSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`backups contract mismatch: ${parsed.summary}`)
  return parsed as BackupsView
}

/**
 * Backups are global: an archive holds the panel's own files plus one entry per
 * workspace, and `include` carries **leaf** ids (`workspace:<id>:servers`, …).
 */
export function createBackup(password?: string, include?: string[]): Promise<unknown> {
  const body: Record<string, unknown> = {}
  if (password !== undefined && password.length > 0)
    body.password = password
  if (include !== undefined && include.length > 0)
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
  if (!response.ok)
    throw new Error(payload?.message ?? payload?.error ?? `restore failed with ${response.status}`)
  return payload as RestorePlan
}

export function saveTelegramToken(botToken: string, workspace?: string | null): Promise<{ ok: boolean, username: string | null }> {
  return request(scoped('/api/notifications/token', workspace), { method: 'PUT', body: JSON.stringify({ botToken }) })
}

export function clearTelegramToken(workspace?: string | null): Promise<unknown> {
  return request(scoped('/api/notifications/token', workspace), { method: 'DELETE' })
}

export function sendTelegramTest(payload: { botToken?: string, chatId?: string }, workspace?: string | null): Promise<{ ok: boolean, error?: string }> {
  return request(scoped('/api/notifications/test', workspace), { method: 'POST', body: JSON.stringify(payload) })
}

export function detectTelegramChats(payload: { botToken?: string }, workspace?: string | null): Promise<{ chats: Array<{ id: number | string, title: string }> }> {
  return request(scoped('/api/notifications/detect-chats', workspace), { method: 'POST', body: JSON.stringify(payload) })
}

export async function fetchDdns(workspace?: string | null): Promise<DdnsView> {
  return ddnsView(await request<unknown>(scoped('/api/ddns', workspace)))
}

export async function saveDdns(config: DdnsConfig, workspace?: string | null): Promise<DdnsView> {
  return ddnsView(await request<unknown>(scoped('/api/ddns', workspace), { method: 'PUT', body: JSON.stringify(config) }))
}

/** The provider travels with the request: the account may still be an unsaved draft. */
export async function saveDdnsCredentials(id: string, provider: string, credentials: Record<string, string>, workspace?: string | null): Promise<DdnsView> {
  return ddnsView(await request<unknown>(scoped(`/api/ddns/credentials/${encodeURIComponent(id)}`, workspace), { method: 'PUT', body: JSON.stringify({ provider, credentials }) }))
}

export async function clearDdnsCredentials(id: string, workspace?: string | null): Promise<DdnsView> {
  return ddnsView(await request<unknown>(scoped(`/api/ddns/credentials/${encodeURIComponent(id)}`, workspace), { method: 'DELETE' }))
}

/** Runs a pass now; the answer carries the fresh status. */
export async function checkDdns(workspace?: string | null): Promise<DdnsView> {
  return ddnsView(await request<unknown>(scoped('/api/ddns/check', workspace), { method: 'POST' }))
}

export function uploadTls(certificate: string, privateKey: string): Promise<SettingsSaveResult> {
  return request('/api/settings/tls', { method: 'POST', body: JSON.stringify({ certificate, privateKey }) })
}

export function clearTls(): Promise<SettingsSaveResult> {
  return request('/api/settings/tls', { method: 'DELETE' })
}

/** Empty version installs the current release; a version asks for a named one. */

/**
 * Lifecycle calls are plain `fetch`: the route is workspace-scoped, and a
 * missing one must surface as an error the UI can show, never as a build break
 * in an unrelated app module.
 */
export async function serverAction(id: string, action: 'start' | 'stop' | 'restart', workspace?: string | null): Promise<ActionResult> {
  const response = await fetch(scoped(`/api/servers/${encodeURIComponent(id)}/${action}`, workspace), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  const payload = await response.json().catch(() => null) as (ActionResult & { message?: string }) | null
  if (!response.ok)
    throw new Error(payload?.message ?? `request failed with ${response.status}`)
  return payload ?? { ok: true }
}

export function startAll(workspace?: string | null): Promise<unknown> {
  return request(scoped('/api/servers/start-all', workspace), { method: 'POST' })
}

export function stopAll(workspace?: string | null): Promise<unknown> {
  return request(scoped('/api/servers/stop-all', workspace), { method: 'POST' })
}

export function clearLogs(id: string, workspace?: string | null): Promise<unknown> {
  return request(scoped(`/api/servers/${encodeURIComponent(id)}/clear-logs`, workspace), { method: 'POST' })
}

export type ServerPatchPayload = Partial<ServerPatch> & Record<string, unknown>

export function patchServer(id: string, patch: ServerPatchPayload, workspace?: string | null): Promise<unknown> {
  return request(scoped(`/api/servers/${encodeURIComponent(id)}`, workspace), {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function removeServer(id: string, workspace?: string | null): Promise<unknown> {
  return request(scoped(`/api/servers/${encodeURIComponent(id)}`, workspace), { method: 'DELETE' })
}

export type CreateServerPayload = ServerCreate

export function createServer(payload: CreateServerPayload, workspace?: string | null): Promise<unknown> {
  return request(scoped('/api/servers', workspace), { method: 'POST', body: JSON.stringify(payload) })
}
