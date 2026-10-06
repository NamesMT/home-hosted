import type { LogLine, ServerView, SettingsPatch, WorkspaceSettingsPatch } from '@shared/contracts'
import type { MaybeRefOrGetter, Ref } from 'vue'
import type { AppStateView } from '@/lib/api'
import type { ServerSeries } from '@/lib/telemetry'
import { parseBind, sseMessageSchema } from '@shared/contracts'
/** The composite key every per-server buffer and series is stored under. */
// Imported as well as re-exported: this module calls `serverKey` itself, and a re-export does not
// bring the name into scope.
import { serverKey } from '@shared/server-key'
import { type } from 'arktype'
import { computed, onScopeDispose, readonly, ref, toValue, watch } from 'vue'
import { useSession } from '@/composables/useSession'
import { useToasts } from '@/composables/useToasts'
import * as api from '@/lib/api'

import { createSeries, recordSample } from '@/lib/telemetry'

export type ConnectionState = 'connecting' | 'open' | 'closed'

/** Lines kept per server client-side; the disk tail holds the archive. */
export const MAX_CLIENT_LINES = 8000

const appState = ref<AppStateView | null>(null)
const connection = ref<ConnectionState>('connecting')
const lastError = ref<string | null>(null)
const now = ref(Date.now())
/** Server ids repeat across workspaces, so every per-server map is keyed by both. */
const series = new Map<string, ServerSeries>()
const notifier = useToasts()

export { serverKey } from '@shared/server-key'

interface LogBuffer {
  lines: LogLine[]
  version: Ref<number>
  refs: number
  source: EventSource | null
}

const buffers = new Map<string, LogBuffer>()

/**
 * Bumped on every buffer mutation. `lines` is a plain array mutated in place, and
 * a buffer may not even exist when a view first evaluates its version, so a single
 * always-live counter is what makes the log views re-render on the first line and
 * on every one after it. Without it the version computed caches once and the
 * viewer stays empty until something else forces a re-render.
 */
const logRevision = ref(0)

let globalSource: EventSource | null = null
let clock: ReturnType<typeof setInterval> | null = null

function bufferFor(key: string): LogBuffer {
  const existing = buffers.get(key)
  if (existing)
    return existing
  const created: LogBuffer = { lines: [], version: ref(0), refs: 0, source: null }
  buffers.set(key, created)
  return created
}

function appendLines(key: string, batch: LogLine[]): void {
  const buffer = bufferFor(key)
  // A new array per batch, never a push. A computed is only re-read by its
  // subscribers when its own recomputed value *differs*, and Vue compares with
  // Object.is — an array mutated in place is always equal to itself, so a viewer's
  // line count stayed frozen at whatever it read first. The counters below are what
  // tell the views to re-read the buffer at all.
  const merged = buffer.lines.concat(batch)
  buffer.lines = merged.length > MAX_CLIENT_LINES ? merged.slice(merged.length - MAX_CLIENT_LINES) : merged
  buffer.version.value += 1
  logRevision.value += 1
}

export function liveLines(key: string): LogLine[] {
  return buffers.get(key)?.lines ?? []
}

export function resetLogs(key: string): void {
  const buffer = buffers.get(key)
  if (!buffer)
    return
  buffer.lines = []
  buffer.version.value += 1
  logRevision.value += 1
}

function seriesFor(key: string): ServerSeries {
  const existing = series.get(key)
  if (existing)
    return existing
  const created = createSeries()
  series.set(key, created)
  return created
}

function trackServer(server: ServerView): void {
  if (server.workspaceId === undefined)
    return
  recordSample(seriesFor(serverKey(server.workspaceId, server.id)), server, Date.now())
}

/**
 * Replaces one entry in the frame. A `server` frame may omit `workspaceId` (an
 * older panel), so an id that exists in exactly one workspace is unambiguous;
 * anything else is dropped rather than guessed at.
 */
function upsertServer(server: ServerView): void {
  const current = appState.value
  if (!current)
    return

  const explicit = server.workspaceId
  const target = explicit === undefined
    ? current.workspaces.filter(workspace => workspace.servers.some(entry => entry.id === server.id))
    : current.workspaces.filter(workspace => workspace.id === explicit)
  if (target.length !== 1)
    return

  const workspace = target[0]!
  const nested = workspace.servers.find(entry => entry.id === server.id)
  const withWorkspace: ServerView = explicit === undefined ? { ...server, workspaceId: workspace.id } : server
  if (nested === undefined)
    workspace.servers = [...workspace.servers, withWorkspace]
  else
    workspace.servers = workspace.servers.map(entry => (entry.id === server.id ? withWorkspace : entry))
}

function handleMessage(raw: string): void {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  }
  catch {
    return
  }

  const parsed = sseMessageSchema(payload)
  if (parsed instanceof type.errors) {
    console.warn('[home-hosted] ignored malformed SSE frame', parsed.summary)
    return
  }

  if (parsed.type === 'hello' || parsed.type === 'state') {
    if (parsed.state) {
      appState.value = parsed.state as AppStateView
      for (const workspace of appState.value.workspaces) {
        for (const server of workspace.servers)
          trackServer(server)
      }
    }
    return
  }

  if (parsed.type === 'server' && parsed.server) {
    const server = parsed.server as ServerView
    upsertServer(server)
    trackServer(server)
    return
  }

  if (parsed.type === 'log' && parsed.serverId && parsed.lines) {
    const workspaceId = parsed.workspaceId
    if (workspaceId === undefined)
      return
    appendLines(serverKey(workspaceId, parsed.serverId), parsed.lines)
  }
}

function openServerStream(workspaceId: string, serverId: string, buffer: LogBuffer): void {
  const key = serverKey(workspaceId, serverId)
  // Every connect replays the panel's last 200 buffered lines, so anything kept from a
  // previous connection would be shown twice — leaving the Logs page for Persisted and
  // coming back, or a server detail view unmounting, did exactly that. Start clean; this
  // is the one place a stream begins.
  buffer.lines = []
  buffer.version.value += 1
  logRevision.value += 1
  const source = new EventSource(`/api/servers/${encodeURIComponent(serverId)}/stream${api.workspaceQuery(workspaceId)}`)
  const listener = (event: Event): void => {
    const message = event as MessageEvent<string>
    let payload: unknown
    try {
      payload = JSON.parse(message.data)
    }
    catch {
      return
    }
    const parsed = sseMessageSchema(payload)
    if (parsed instanceof type.errors) {
      console.warn('[home-hosted] ignored malformed SSE frame', parsed.summary)
      return
    }
    if (parsed.type === 'log' && parsed.lines) {
      appendLines(key, parsed.lines)
      return
    }
    if (parsed.type === 'server' && parsed.server)
      upsertServer(parsed.server as ServerView)
  }
  for (const event of ['log', 'server'] as const)
    source.addEventListener(event, listener)
  source.onerror = () => {
    // EventSource retries on its own; the shell already shows the global link.
  }
  buffer.source = source
}

function acquireServerStream(workspaceId: string, serverId: string): void {
  const buffer = bufferFor(serverKey(workspaceId, serverId))
  buffer.refs += 1
  if (!buffer.source)
    openServerStream(workspaceId, serverId, buffer)
}

function releaseServerStream(workspaceId: string, serverId: string): void {
  const buffer = buffers.get(serverKey(workspaceId, serverId))
  if (!buffer)
    return
  buffer.refs = Math.max(0, buffer.refs - 1)
  if (buffer.refs === 0) {
    buffer.source?.close()
    buffer.source = null
  }
}

export function connect(): void {
  if (globalSource)
    return

  clock ??= setInterval(() => {
    now.value = Date.now()
  }, 1000)

  const source = new EventSource('/api/events?logs=0')
  globalSource = source
  connection.value = 'connecting'

  source.onopen = () => {
    connection.value = 'open'
  }
  source.onerror = () => {
    connection.value = 'closed'
  }
  for (const event of ['hello', 'state', 'server', 'log'] as const) {
    source.addEventListener(event, (message) => {
      handleMessage((message as MessageEvent<string>).data)
    })
  }
}

export function disconnect(): void {
  globalSource?.close()
  globalSource = null
  if (clock)
    clearInterval(clock)
  clock = null
}

/**
 * Live log subscription for one server, refcounted so several widgets can watch
 * the same stream. The control plane replays its ring buffer on connect.
 */
export function useServerLogs(workspaceId: MaybeRefOrGetter<string | null>, serverId: MaybeRefOrGetter<string | null>) {
  const current = computed(() => {
    const workspace = toValue(workspaceId)
    const server = toValue(serverId)
    return workspace === null || server === null ? null : serverKey(workspace, server)
  })
  let held: string | null = null

  watch(current, (key) => {
    if (held !== null && held !== key) {
      const [workspace, server] = held.split('/')
      if (workspace !== undefined && server !== undefined)
        releaseServerStream(workspace, server)
    }
    held = key
    if (key !== null) {
      const [workspace, server] = key.split('/')
      if (workspace !== undefined && server !== undefined)
        acquireServerStream(workspace, server)
    }
  }, { immediate: true })

  onScopeDispose(() => {
    if (held !== null) {
      const [workspace, server] = held.split('/')
      if (workspace !== undefined && server !== undefined)
        releaseServerStream(workspace, server)
    }
    held = null
  })

  const version = computed(() => {
    const key = current.value
    // `logRevision` is the dependency that always exists; the per-buffer counter
    // is only the value, so the first append still invalidates this.
    void logRevision.value
    return key === null ? 0 : buffers.get(key)?.version.value ?? 0
  })

  return {
    version,
    lines(): LogLine[] {
      const key = current.value
      return key === null ? [] : liveLines(key)
    },
    count: computed(() => {
      const key = current.value
      void logRevision.value
      return key === null ? 0 : buffers.get(key)?.lines.length ?? 0
    }),
    clear(): void {
      const key = current.value
      if (key !== null)
        resetLogs(key)
    },
  }
}

/**
 * The panel-wide state stream plus the low-level, explicitly workspace-scoped
 * actions. Views that work on "the selected workspace" should use
 * `useWorkspaces()` instead — it binds these to the selection.
 */
export function useControlPlane() {
  const workspaces = computed(() => appState.value?.workspaces ?? [])
  const allServers = computed(() => workspaces.value.flatMap(workspace =>
    workspace.servers.map(server => ({ workspace, server }))))
  const control = computed(() => appState.value?.control ?? null)
  const host = computed(() => appState.value?.host ?? null)
  const backups = computed(() => appState.value?.backups ?? null)
  /** Optional: a panel that predates the reverse proxy sends no `proxy` field. */
  const proxy = computed(() => appState.value?.proxy ?? null)
  const projectDir = computed(() => appState.value?.projectDir ?? null)
  const dataRoot = computed(() => appState.value?.dataRoot ?? null)
  const version = computed(() => appState.value?.version ?? null)

  function workspaceById(id: string) {
    return appState.value?.workspaces.find(workspace => workspace.id === id)
  }

  function serverById(workspaceId: string, id: string): ServerView | undefined {
    return workspaceById(workspaceId)?.servers.find(server => server.id === id)
  }

  function seriesOf(workspaceId: string, id: string): ServerSeries {
    return seriesFor(serverKey(workspaceId, id))
  }

  /**
   * Reads the frame once when nothing is loaded yet. The router guard needs the
   * workspace list to canonicalize a URL, and it runs before the shell mounts.
   */
  async function ensureState(): Promise<void> {
    if (appState.value !== null)
      return
    try {
      appState.value = await api.fetchState()
    }
    catch (error) {
      if (error instanceof api.AuthRequiredError)
        useSession().requireLogin()
    }
  }

  async function run<T>(
    action: () => Promise<T>,
    options: { title: string, success?: string | ((result: T) => string) },
  ): Promise<T | undefined> {
    lastError.value = null
    try {
      const result = await action()
      appState.value = await api.fetchState()
      const message = typeof options.success === 'function' ? options.success(result) : options.success
      if (message)
        notifier.success(message)
      return result
    }
    catch (error) {
      if (error instanceof api.AuthRequiredError) {
        useSession().requireLogin()
        return undefined
      }
      const message = error instanceof Error ? error.message : String(error)
      lastError.value = message
      notifier.failure(options.title, message)
      return undefined
    }
  }

  return {
    appState: appState as Readonly<Ref<AppStateView | null>>,
    workspaces,
    allServers,
    control,
    host,
    backups,
    proxy,
    projectDir,
    dataRoot,
    version,
    connection: readonly(connection),
    lastError: readonly(lastError),
    now: readonly(now),
    workspaceById,
    ensureState,
    serverById,
    seriesOf,

    refresh: (title = 'Refresh failed') => run(async () => {}, { title }),

    start: (workspaceId: string, id: string) => run(() => api.serverAction(workspaceId, id, 'start'), { title: `Could not start ${id}` }),
    stop: (workspaceId: string, id: string) => run(() => api.serverAction(workspaceId, id, 'stop'), { title: `Could not stop ${id}` }),
    restart: (workspaceId: string, id: string) => run(() => api.serverAction(workspaceId, id, 'restart'), { title: `Could not restart ${id}` }),
    startAll: (workspaceId: string) => run(() => api.startAll(workspaceId), { title: 'Could not start every server', success: 'Starting every enabled server' }),
    stopAll: (workspaceId: string) => run(() => api.stopAll(workspaceId), { title: 'Could not stop every server', success: 'Stopping every server' }),
    setAutostart: (workspaceId: string, id: string, autostart: boolean) => run(() => api.patchServer(workspaceId, id, { autostart }), { title: `Could not change autostart for ${id}` }),
    setEnabled: (workspaceId: string, id: string, enabled: boolean) => run(() => api.patchServer(workspaceId, id, { enabled }), { title: `Could not change ${id}` }),
    /**
     * Frees the port a blocked entry wants. The endpoint reports what it did, so
     * the toast can say whether the port actually came free.
     */
    freePort: (workspaceId: string, id: string) => run(() => api.freePort(workspaceId, id), {
      title: `Could not free the port for ${id}`,
      success: result => (result.free
        ? `Port ${result.port} is free — start ${id} now`
        : `Port ${result.port} is still held`),
    }),
    setBind: (workspaceId: string, id: string, bind: string) => {
      const parsed = parseBind(bind)
      if (parsed === null) {
        notifier.failure(`Could not change the bind for ${id}`, `"${bind}" is not a bind value`)
        return Promise.resolve(undefined)
      }
      return run(() => api.patchServer(workspaceId, id, { bind: parsed }), { title: `Could not change the bind for ${id}` })
    },
    saveConfig: (workspaceId: string, id: string, patch: Record<string, unknown>) => run(() => api.patchServer(workspaceId, id, patch), { title: `Could not save ${id}`, success: `${id} updated` }),
    saveGlobalSettings: (patch: SettingsPatch) => run(() => api.patchSettings(patch), { title: 'Could not save the settings' }),
    saveWorkspaceSettings: (workspaceId: string, patch: WorkspaceSettingsPatch) => run(() => api.patchWorkspaceSettings(workspaceId, patch), { title: 'Could not save the settings' }),
    clearLogs: (workspaceId: string, id: string) => run(async () => {
      await api.clearLogs(workspaceId, id)
      resetLogs(serverKey(workspaceId, id))
    }, { title: `Could not clear the logs for ${id}`, success: 'Buffer cleared' }),
    create: (workspaceId: string, payload: api.CreateServerPayload) => run(() => api.createServer(workspaceId, payload), { title: 'Could not add the server', success: 'Server added' }),
    remove: (workspaceId: string, id: string) => run(async () => {
      await api.removeServer(workspaceId, id)
      releaseServerStream(workspaceId, id)
      buffers.delete(serverKey(workspaceId, id))
      series.delete(serverKey(workspaceId, id))
    }, { title: `Could not remove ${id}`, success: `${id} removed` }),
  }
}
