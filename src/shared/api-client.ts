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
 * **The workspace-scoped half lives here too** (see "Workspace-scoped calls" at the foot of this
 * file). It used to be a hand-maintained copy in each UI's `lib/api.ts`, on the theory that each
 * spells the workspace differently. They did not: 387 and 386 lines, 61% identical, 31 of 35 shared
 * names, and three drifts. The only genuine difference was *where the workspace comes from*, which
 * is now one injected resolver — see `useWorkspaceResolver`.
 */
import type { AppState, BackupSelection, DdnsConfig, DdnsView, FreePortResult, LogHistoryView, LogServerView, ProxyPatch, ProxyView, RestorePlan, ServerCreate, ServerPatch, ServerView, SessionView, SettingsPatch, SettingsSaved, SettingsView, UiStatus, WorkspaceCreate, WorkspaceSettingsPatch, WorkspaceSettingsView, WorkspaceView, WslTemperatureStatus } from './contracts'
import { type } from 'arktype'
import { backupSelectionSchema, ddnsViewSchema, freePortResultSchema, logHistoryViewSchema, loginSchema, logServersViewSchema, passwordSchema, proxyCertificateUploadSchema, proxyPatchSchema, proxyViewSchema, settingsPatchSchema, settingsSavedSchema, tlsReviewResponseSchema, tlsUploadSchema, workspaceCreateSchema, workspaceRenameSchema, workspaceSettingsPatchSchema, workspaceSettingsViewSchema, workspaceViewSchema } from './contracts'
import { parseState } from './live-frames'
import { isRecord } from './shape'

/** Thrown on a 401 with `code: "AUTH_REQUIRED"`, so the SPA can route to the login view. */
export class AuthRequiredError extends Error {
  override name = 'AuthRequiredError'

  constructor() {
    super('authentication required')
  }
}

/**
 * Thrown on a 401 that signing in cannot fix: no password is in force, so only the machine running
 * the panel may use `/api`. `AUTH_UNARMED` is auth on without a password; `AUTH_DISABLED_REMOTE` is
 * auth off and a caller that is not this machine. Both are answered the same way — set a password on
 * that machine — and the message is the panel's own sentence saying so.
 */
export class LocalOnlyError extends Error {
  override name = 'LocalOnlyError'

  constructor(message: string, readonly code: string) {
    super(message)
  }
}

/** The 401 codes `LocalOnlyError` stands for. */
export const LOCAL_ONLY_CODES: ReadonlySet<string> = new Set(['AUTH_UNARMED', 'AUTH_DISABLED_REMOTE'])

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
  const payload = parsePayload(text, response.ok)

  if (!response.ok) {
    if (response.status === 401 && isRecord(payload) && payload.code === 'AUTH_REQUIRED')
      throw new AuthRequiredError()
    if (response.status === 401 && isRecord(payload) && typeof payload.code === 'string' && LOCAL_ONLY_CODES.has(payload.code))
      throw new LocalOnlyError(failureMessage(payload, response.status), payload.code)
    throw new Error(failureMessage(payload, response.status))
  }

  return payload as T
}

/**
 * A failure's body may not be JSON (a proxy in front of the panel, an older panel's plain-text 404),
 * and a SyntaxError would hide the status the person needs; a success that is not JSON is a fault.
 */
function parsePayload(text: string, ok: boolean): unknown {
  if (text.length === 0)
    return null
  try {
    return JSON.parse(text)
  }
  catch (error) {
    if (ok)
      throw error
    return null
  }
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

/**
 * What a created backup wants a person to look at: a declared path that held no files, say. The
 * archive was still written. Absent on an older panel, and anything that is not a string is ignored.
 */
export function backupWarnings(result: unknown): string[] {
  if (!isRecord(result) || !Array.isArray(result.warnings))
    return []
  return result.warnings.filter((warning): warning is string => typeof warning === 'string' && warning.length > 0)
}

/** Replaces the API token with a new one, returned once. Needs a signed-in session. */
export function generateApiToken(): Promise<{ token: string, hint: string }> {
  return request('/api/auth/token', { method: 'POST' })
}

export function revokeApiToken(): Promise<unknown> {
  return request('/api/auth/token', { method: 'DELETE' })
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

/* --------------------------------------------------------------------------------------------
 * Workspace-scoped calls
 *
 * Every server, log, DDNS, notification and workspace-settings route takes a `?workspace=<id>`,
 * and omitting it means "the panel's own default". These 35 calls were a copy in each UI until the
 * copies were measured: 61% identical lines, 31 of 35 shared names, and three drifts (the backups
 * payload validated in one UI and cast in the other; the log-history query built two ways; a
 * `scoped()` that one copy made `?`-aware and the other did not).
 *
 * The one real difference was where the workspace came from, so that is the one seam: a resolver
 * the UI installs once. Everything else — the URL shape, the validation, the error envelope — is
 * decided here.
 * ------------------------------------------------------------------------------------------ */

/**
 * Where a call's workspace comes from when the caller does not name one.
 *
 * `null` means "let the panel pick its default", which is right for a single-workspace instance.
 * `noc-console` installs a resolver reading its reactive `selectedWorkspaceId`; `stock` installs
 * nothing, because every one of its call sites names the workspace explicitly.
 */
let resolveWorkspace: () => string | null = () => null

/**
 * Install the workspace resolver; called once per UI at module load.
 *
 * A setter rather than a constructor argument because the call sites are free functions the views
 * import directly (`api.fetchLogServers()`), and threading an instance through every component
 * would rewrite every view to buy nothing.
 */
export function useWorkspaceResolver(resolve: () => string | null): void {
  resolveWorkspace = resolve
}

/**
 * One workspace-scoped URL: `path` plus a `workspace` query, merged with whatever `extra` carries.
 *
 * A caller that names a workspace wins; the resolver is consulted only when it did not. An empty
 * string counts as omitted — a blank id is never a workspace, and `?workspace=` would be a 404 on
 * any panel whose default is not blank.
 *
 * The separator is chosen against the **path**, so a route already carrying a query (the log
 * download link) appends with `&` instead of a second `?`. `stock`'s copy lacked that and was saved
 * from being a live bug only by having no such caller; shared, it would have become both UIs'.
 */
export function scoped(path: string, workspace?: string | null, extra?: URLSearchParams): string {
  const params = extra === undefined ? new URLSearchParams() : new URLSearchParams(extra)
  // A blank id is "not named", so it falls through to the resolver like an omission. `??` alone
  // would keep `''` (not nullish) and silently skip the resolver, which is the answer this
  // function's contract promises it will not do.
  const named = workspace !== null && workspace !== undefined && workspace.length > 0 ? workspace : resolveWorkspace()
  if (named !== null && named !== undefined && named.length > 0)
    params.set('workspace', named)
  const query = params.toString()
  if (query.length === 0)
    return path
  return `${path}${path.includes('?') ? '&' : '?'}${query}`
}

/** A contract mismatch names the thing that drifted, rather than surfacing as a render error. */
function boundary<T>(schema: (value: unknown) => T | type.errors, payload: unknown, what: string): T {
  const parsed = schema(payload)
  if (parsed instanceof type.errors)
    throw new Error(`${what} contract mismatch: ${parsed.summary}`)
  return parsed as T
}

/**
 * The typed view of a frame: the schema accepts a request-shaped `port` (possibly absent) while the
 * panel always emits the normalized `number | null`, so these carry that one narrowing.
 */
export type WorkspaceState = Omit<WorkspaceView, 'servers'> & { servers: ServerView[] }
export type AppStateView = Omit<AppState, 'workspaces'> & { workspaces: WorkspaceState[] }

export interface ActionResult {
  ok: boolean
  error?: string
}

export interface LogServerInfo extends LogServerView {}

export interface LogQuery {
  tail?: number
  search?: string
  stream?: string
}

export interface WorkspaceRemoved {
  ok: boolean
  removed: unknown
}

const workspacesViewSchema = type({ workspaces: workspaceViewSchema.array() })
const workspaceAnswerSchema = type({ workspace: workspaceViewSchema })
const workspaceRemovedSchema = type({ ok: 'boolean', removed: 'unknown' })

/** Validated at the boundary: contract drift fails loudly here, not in the UI. */
export async function fetchState(): Promise<AppStateView> {
  const payload = await request<unknown>('/api/state')
  // Tolerant of an enum value a newer panel added: one unknown status must not blank the UI.
  const parsed = parseState(payload)
  if (parsed === null)
    throw new Error('state contract mismatch')
  // The schema accepts both `port` forms; the control plane always sends the normalized one.
  return parsed as AppStateView
}

/** Every workspace the panel serves, in panel order; the first is the default. */
export async function fetchWorkspaces(): Promise<WorkspaceState[]> {
  const parsed = boundary(workspacesViewSchema, await request<unknown>('/api/workspaces'), 'workspaces')
  return parsed.workspaces as WorkspaceState[]
}

async function workspaceAnswer(payload: unknown): Promise<WorkspaceState> {
  const parsed = boundary(workspaceAnswerSchema, payload, 'workspace')
  return parsed.workspace as WorkspaceState
}

export async function createWorkspace(input: WorkspaceCreate = {}): Promise<WorkspaceState> {
  const parsed = boundary(workspaceCreateSchema, input, 'workspace')
  return workspaceAnswer(await request<unknown>('/api/workspaces', { method: 'POST', body: JSON.stringify(parsed) }))
}

export async function renameWorkspace(id: string, label: string): Promise<WorkspaceState> {
  const parsed = boundary(workspaceRenameSchema, { label }, 'workspace rename')
  return workspaceAnswer(await request<unknown>(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(parsed),
  }))
}

/**
 * Stop and remove a workspace.
 *
 * One spelling, returning the removal the route documents. The copies differed — one typed the
 * answer as `WorkspaceRemoved`, the other as an inline duplicate of the same object literal — and
 * only this one was validated.
 */
export async function deleteWorkspace(id: string): Promise<{ ok: boolean, removed: { id: string, label: string } }> {
  return boundary(workspaceRemovedSchema, await request<unknown>(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' }), 'workspace removal') as { ok: boolean, removed: { id: string, label: string } }
}

/**
 * Writes the panel-wide groups, answering with where the listener lands.
 *
 * Validated, because this answer decides a redirect: `rebinding`/`targetUrl` is what tells the page
 * to follow the panel to a new origin. A cast here would let a missing pair read as `undefined`,
 * which is falsy, and leave the browser on a stale socket with no error.
 */
export async function patchSettings(patch: SettingsPatch): Promise<SettingsSaved> {
  const parsed = boundary(settingsPatchSchema, patch, 'settings patch')
  return boundary(settingsSavedSchema, await request<unknown>('/api/settings', { method: 'PATCH', body: JSON.stringify(parsed) }), 'settings') as SettingsSaved
}

/** `GET /api/settings/workspace?workspace=<id>`: defaults, logs and notifications. */
export async function fetchWorkspaceSettings(workspace?: string | null): Promise<WorkspaceSettingsView> {
  return boundary(workspaceSettingsViewSchema, await request<unknown>(scoped('/api/settings/workspace', workspace)), 'workspace settings') as WorkspaceSettingsView
}

export async function patchWorkspaceSettings(patch: WorkspaceSettingsPatch, workspace?: string | null): Promise<WorkspaceSettingsView> {
  const parsed = boundary(workspaceSettingsPatchSchema, patch, 'workspace settings patch')
  const payload = await request<unknown>(scoped('/api/settings/workspace', workspace), {
    method: 'PATCH',
    body: JSON.stringify(parsed),
  })
  // The route answers the view; `workspaceSettingsSavedSchema` is an alias of that same schema, so
  // naming it here only suggested a distinct "saved" shape that does not exist.
  return boundary(workspaceSettingsViewSchema, payload, 'workspace settings') as WorkspaceSettingsView
}

export async function fetchLogServers(workspace?: string | null): Promise<LogServerInfo[]> {
  const parsed = boundary(logServersViewSchema, await request<unknown>(scoped('/api/logs', workspace)), 'logs')
  return parsed.servers as LogServerInfo[]
}

export async function fetchLogHistory(id: string, query: LogQuery, workspace?: string | null): Promise<LogHistoryView> {
  const params = new URLSearchParams()
  if (query.tail !== undefined)
    params.set('tail', String(query.tail))
  if (query.search !== undefined && query.search.length > 0)
    params.set('search', query.search)
  if (query.stream !== undefined && query.stream.length > 0)
    params.set('stream', query.stream)

  // The workspace rides in `extra`, so one helper builds the whole query and a path that already
  // carries its own `?` stays correct. The copies had one build the query and the other prepend it.
  const payload = await request<unknown>(scoped(`/api/logs/${encodeURIComponent(id)}`, workspace, params))
  return boundary(logHistoryViewSchema, payload, 'log history') as LogHistoryView
}

export function clearLogHistory(id: string, workspace?: string | null): Promise<unknown> {
  return request(scoped(`/api/logs/${encodeURIComponent(id)}`, workspace), { method: 'DELETE' })
}

/** Direct link; the session cookie is sent by the browser. */
export function logDownloadUrl(id: string, file: string, workspace?: string | null): string {
  return scoped(`/api/logs/${encodeURIComponent(id)}/download`, workspace, new URLSearchParams({ file }))
}

/**
 * Backups are panel-wide: every workspace is a selectable entry in the archive.
 *
 * Validated, which is the half of this pair that used to differ — one UI checked the payload, the
 * other cast it, so a contract change would have surfaced as an empty capture tree in exactly one
 * product.
 */
export async function fetchBackups(): Promise<BackupSelection> {
  return boundary(backupSelectionSchema, await request<unknown>('/api/backups'), 'backups') as BackupSelection
}

/**
 * A Telegram destination's bot token.
 *
 * Keyed by destination id in the path: a workspace may point at several chats and each carries its
 * own bot. The token never travels in the settings patch, so it never lands in a config file.
 */
export function saveTelegramToken(id: string, botToken: string, workspace?: string | null): Promise<{ ok: boolean, username: string | null }> {
  return request(scoped(`/api/notifications/destinations/${encodeURIComponent(id)}/token`, workspace), { method: 'PUT', body: JSON.stringify({ botToken }) })
}

export function clearTelegramToken(id: string, workspace?: string | null): Promise<unknown> {
  return request(scoped(`/api/notifications/destinations/${encodeURIComponent(id)}/token`, workspace), { method: 'DELETE' })
}

export function sendTelegramTest(id: string, payload: { chatId?: string }, workspace?: string | null): Promise<{ ok: boolean, error?: string }> {
  return request(scoped(`/api/notifications/destinations/${encodeURIComponent(id)}/test`, workspace), { method: 'POST', body: JSON.stringify(payload) })
}

export function detectTelegramChats(id: string, payload: { botToken?: string }, workspace?: string | null): Promise<{ chats: Array<{ id: number | string, title: string }> }> {
  return request(scoped(`/api/notifications/destinations/${encodeURIComponent(id)}/detect-chats`, workspace), { method: 'POST', body: JSON.stringify(payload) })
}

/**
 * One webhook destination, as a settings form holds it. The whole draft travels, so an unsaved URL
 * and header block are what gets tried — `id` is echoed so the result lands against the right row.
 */
export interface WebhookTestTarget {
  url: string
  method: 'POST' | 'PUT'
  format: 'json' | 'text'
  headers: string
  enabled: boolean
  cooldownMs: number
  onCrash: boolean
  onUnhealthy: boolean
  onForcedRestart: boolean
  onRecovered: boolean
  onHost: boolean
  onDdns: boolean
}

export function testWebhook(workspace: string | null | undefined, payload: { target: WebhookTestTarget, id?: string }): Promise<{ ok: boolean, error?: string }> {
  return request(scoped('/api/notifications/test-webhook', workspace), { method: 'POST', body: JSON.stringify(payload) })
}

export async function fetchDdns(workspace?: string | null): Promise<DdnsView> {
  return ddnsView(await request<unknown>(scoped('/api/ddns', workspace)))
}

export async function saveDdns(config: DdnsConfig, workspace?: string | null): Promise<DdnsView> {
  return ddnsView(await request<unknown>(scoped('/api/ddns', workspace), { method: 'PUT', body: JSON.stringify(config) }))
}

/** The provider travels with the request: the account may still be an unsaved draft. */
export async function saveDdnsCredentials(id: string, provider: string, credentials: Record<string, string>, workspace?: string | null): Promise<DdnsView> {
  return ddnsView(await request<unknown>(scoped(`/api/ddns/credentials/${encodeURIComponent(id)}`, workspace), {
    method: 'PUT',
    body: JSON.stringify({ provider, credentials }),
  }))
}

export async function clearDdnsCredentials(id: string, workspace?: string | null): Promise<DdnsView> {
  return ddnsView(await request<unknown>(scoped(`/api/ddns/credentials/${encodeURIComponent(id)}`, workspace), { method: 'DELETE' }))
}

/** Runs a pass now; the answer carries the fresh status. */
export async function checkDdns(workspace?: string | null): Promise<DdnsView> {
  return ddnsView(await request<unknown>(scoped('/api/ddns/check', workspace), { method: 'POST' }))
}

/**
 * One lifecycle call: start, stop or restart an entry.
 *
 * Plain `fetch`, not the typed RPC client `stock` had adopted. `rpc` is inferred from `AppType` in
 * the server's `src/app.ts`, which `src/shared` may not import — that layering is what lets the
 * server and both UIs build on this module. Nothing is lost by it here: a lifecycle refusal answers
 * `{ ok: false, error }` rather than the `{ message }` envelope, and `failureMessage` reads both, so
 * "port 3000 is already in use" still reaches the toast instead of "request failed with 409".
 */
export async function serverAction(id: string, action: 'start' | 'stop' | 'restart', workspace?: string | null): Promise<ActionResult> {
  const response = await fetch(scoped(`/api/servers/${encodeURIComponent(id)}/${action}`, workspace), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  const payload = await response.json().catch(() => null) as (ActionResult & { message?: string }) | null
  if (!response.ok)
    throw new Error(failureMessage(payload, response.status))
  return payload ?? { ok: true }
}

/** Stops a process the panel started that no entry claims any more; see the workspace view. */
export function stopOrphan(workspace: string | null | undefined, serverId: string): Promise<ActionResult> {
  return request<ActionResult>(scoped(`/api/servers/orphans/${encodeURIComponent(serverId)}/stop`, workspace), { method: 'POST' })
}

export function startAll(workspace?: string | null): Promise<unknown> {
  return request(scoped('/api/servers/start-all', workspace), { method: 'POST' })
}

/**
 * Frees a server's port by asking the listener holding it to stop. The server re-lists the holders
 * itself, so a pid quoted in an old banner is never signalled.
 */
export async function freePort(id: string, workspace?: string | null): Promise<FreePortResult> {
  const response = await fetch(scoped(`/api/servers/${encodeURIComponent(id)}/free-port`, workspace), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  const payload = await response.json().catch(() => null) as (FreePortResult & { message?: string }) | null
  if (!response.ok)
    throw new Error(failureMessage(payload, response.status))
  const fallback: FreePortResult = { ok: true, port: null, terminated: [], forced: [], skipped: [], free: false }
  return boundary(freePortResultSchema, payload ?? fallback, 'free port') as FreePortResult
}

/**
 * Stop every server in a workspace.
 *
 * `withPersistent` is the CLI's `--with-persistent`: a persistent entry outlives the panel, so
 * leaving it running is the default and ending it has to be asked for.
 */
export function stopAll(workspace?: string | null, options: { withPersistent?: boolean } = {}): Promise<unknown> {
  const extra = options.withPersistent === true ? new URLSearchParams({ withPersistent: 'true' }) : undefined
  return request(scoped('/api/servers/stop-all', workspace, extra), { method: 'POST' })
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

/** The create body is exactly the strict, defaulted schema the route validates. */
export type CreateServerPayload = ServerCreate

export function createServer(payload: CreateServerPayload, workspace?: string | null): Promise<unknown> {
  return request(scoped('/api/servers', workspace), { method: 'POST', body: JSON.stringify(payload) })
}

/** The per-server event stream, addressed by the workspace that owns it. */
export function serverStreamUrl(id: string, workspace?: string | null): string {
  return scoped(`/api/servers/${encodeURIComponent(id)}/stream`, workspace)
}

/**
 * What the panel's own TLS routes answer: the listener as it stands, and the move in flight.
 *
 * Deliberately **not** `SettingsSaved`. The routes return `{ control, rebinding, targetUrl }` only —
 * no `host`, `backups` or `ui` — so the console's old `uploadTls(): Promise<SettingsSaveResult>`
 * promised three fields the response never carried. A page that read one would have got `undefined`
 * with nothing to fail on.
 */
export type TlsReview = typeof tlsReviewResponseSchema.infer

export async function uploadTls(certificate: string, privateKey: string): Promise<TlsReview> {
  const body = boundary(tlsUploadSchema, { certificate, privateKey }, 'tls upload')
  return boundary(tlsReviewResponseSchema, await request<unknown>('/api/settings/tls', { method: 'POST', body: JSON.stringify(body) }), 'tls') as TlsReview
}

export async function clearTls(): Promise<TlsReview> {
  return boundary(tlsReviewResponseSchema, await request<unknown>('/api/settings/tls', { method: 'DELETE' }), 'tls') as TlsReview
}
