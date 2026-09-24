import type {
  AppState,
  ControlView,
  HostConfig,
  LogHistoryView,
  LogsConfig,
  LogServerView,
  NotificationView,
  ServerDefaults,
  ServerPatch,
  SessionView,
  SettingsPatch,
} from '@shared/contracts'
import {
  appStateSchema,
  logHistoryViewSchema,
  loginSchema,
  logServersViewSchema,
  passwordSchema,
  settingsPatchSchema,
} from '@shared/contracts'
import { type } from 'arktype'
import { rpc } from '@/lib/rpc'

export interface ActionResult {
  ok: boolean
  error?: string
}

export interface UiStatus {
  /** A user-supplied UI is being served instead of the stock one. */
  custom: boolean
  dir: string
  meta: { name: string, version: string | null, uploadedAt: number, files: number } | null
}

export interface SettingsView {
  control: ControlView
  defaults: ServerDefaults
  logs: LogsConfig
  notifications: NotificationView
  host: HostConfig
  backups: BackupsState
  /** Which panel UI is being served, and how to put the stock one back. */
  ui: UiStatus
}

export interface LogServerInfo extends LogServerView {}

export interface LogQuery {
  tail?: number
  search?: string
  stream?: string
}

export interface BackupEntry {
  name: string
  sizeBytes: number
  createdAt: number
  encrypted: boolean
}

export interface BackupPathEntry {
  path: string
  origin: string
  included: boolean
  note: string | null
}

export interface BackupsState {
  enabled: boolean
  dir: string
  keep: number
  includePaths: string[]
  paths: BackupPathEntry[]
  files: BackupEntry[]
}

export interface RestoreItem {
  id: string
  label: string
  kind: 'config' | 'secrets' | 'tls' | 'data'
  restorable: boolean
  selected: boolean
  note: string | null
}

export interface RestorePlan {
  dryRun: boolean
  encrypted: boolean
  needsPassword: boolean
  items: RestoreItem[]
  applied: string[]
  skipped: string[]
  restartRequired: boolean
  /** The panel re-read the restored servers, and started the autostart ones. */
  reloaded: boolean
  error?: string
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })

  const text = await response.text()
  const payload: unknown = text.length > 0 ? JSON.parse(text) : null

  if (!response.ok) {
    if (response.status === 401 && isRecord(payload) && payload.code === 'AUTH_REQUIRED') {
      throw new AuthRequiredError()
    }
    const message = isRecord(payload) && typeof payload.message === 'string'
      ? payload.message
      : `request failed with ${response.status}`
    throw new Error(message)
  }

  return payload as T
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

export function fetchSettings(): Promise<SettingsView> {
  return request<SettingsView>('/api/settings')
}

export function patchSettings(patch: SettingsPatch): Promise<SettingsSaveResult> {
  const parsed = settingsPatchSchema(patch)
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return request<SettingsSaveResult>('/api/settings', { method: 'PATCH', body: JSON.stringify(parsed) })
}

export async function fetchLogServers(): Promise<LogServerInfo[]> {
  const payload = await request<unknown>('/api/logs')
  const parsed = logServersViewSchema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`logs contract mismatch: ${parsed.summary}`)
  return parsed.servers as LogServerInfo[]
}

export async function fetchLogHistory(id: string, query: LogQuery): Promise<LogHistoryView> {
  const params = new URLSearchParams()
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

export function clearLogHistory(id: string): Promise<unknown> {
  return request(`/api/logs/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Direct link; the session cookie is sent by the browser. */
export function logDownloadUrl(id: string, file: string): string {
  return `/api/logs/${encodeURIComponent(id)}/download?file=${encodeURIComponent(file)}`
}

export function fetchBackups(): Promise<BackupsState> {
  return request<BackupsState>('/api/backups')
}

/** The caller re-reads `/api/state` afterwards, which carries the fresh list. */
export function createBackup(password?: string): Promise<unknown> {
  return request('/api/backups', {
    method: 'POST',
    body: JSON.stringify(password === undefined || password.length === 0 ? {} : { password }),
  })
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
  const payload = await response.json().catch(() => null) as (RestorePlan & { message?: string }) | null
  if (!response.ok)
    throw new Error(payload?.message ?? payload?.error ?? `restore failed with ${response.status}`)
  return payload as RestorePlan
}

export function saveTelegramToken(botToken: string): Promise<{ ok: boolean, username: string | null }> {
  return request('/api/notifications/token', { method: 'PUT', body: JSON.stringify({ botToken }) })
}

export function clearTelegramToken(): Promise<unknown> {
  return request('/api/notifications/token', { method: 'DELETE' })
}

export function sendTelegramTest(payload: { botToken?: string, chatId?: string }): Promise<{ ok: boolean, error?: string }> {
  return request('/api/notifications/test', { method: 'POST', body: JSON.stringify(payload) })
}

export function detectTelegramChats(payload: { botToken?: string }): Promise<{ chats: Array<{ id: number | string, title: string }> }> {
  return request('/api/notifications/detect-chats', { method: 'POST', body: JSON.stringify(payload) })
}

/** Replace the panel UI with an uploaded static build (a zip); a refresh shows it. */
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

export function uploadTls(certificate: string, privateKey: string): Promise<SettingsSaveResult> {
  return request('/api/settings/tls', { method: 'POST', body: JSON.stringify({ certificate, privateKey }) })
}

export function clearTls(): Promise<SettingsSaveResult> {
  return request('/api/settings/tls', { method: 'DELETE' })
}

/**
 * Lifecycle calls go through the typed RPC client: the route, its parameter and
 * the result shape come from the server app, so a renamed route fails the build.
 */
export async function serverAction(id: string, action: 'start' | 'stop' | 'restart'): Promise<ActionResult> {
  const response = await rpc.api.servers[':id'][action].$post({ param: { id } })
  const payload = await response.json().catch(() => null) as (ActionResult & { message?: string }) | null
  if (!response.ok)
    throw new Error(payload?.message ?? `request failed with ${response.status}`)
  return payload ?? { ok: true }
}

export function startAll(): Promise<unknown> {
  return rpc.api.servers['start-all'].$post().then(response => response.json())
}

export function stopAll(): Promise<unknown> {
  return rpc.api.servers['stop-all'].$post().then(response => response.json())
}

export function clearLogs(id: string): Promise<unknown> {
  return request(`/api/servers/${encodeURIComponent(id)}/clear-logs`, { method: 'POST' })
}

export type ServerPatchPayload = Partial<ServerPatch> & Record<string, unknown>

export function patchServer(id: string, patch: ServerPatchPayload): Promise<unknown> {
  return request(`/api/servers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function removeServer(id: string): Promise<unknown> {
  return request(`/api/servers/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export interface CreateServerPayload {
  id: string
  label?: string
  command: string
  args?: string[]
  cwd?: string
  port?: number
  bind?: string
  autostart?: boolean
}

export function createServer(payload: CreateServerPayload): Promise<unknown> {
  return request('/api/servers', { method: 'POST', body: JSON.stringify(payload) })
}
