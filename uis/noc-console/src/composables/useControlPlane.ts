import type { Bind, LogLine, ServerView, SettingsPatch, WorkspaceSettingsPatch } from '@shared/contracts'
import type { FlatAppState } from '@/composables/useWorkspaces'
import type { ActionResult, BackupsView, WorkspaceSettings } from '@/lib/api'
import { sseMessageSchema } from '@shared/contracts'
import { type } from 'arktype'
import { computed, onScopeDispose, reactive, readonly, ref } from 'vue'
import { useSession } from '@/composables/useSession'
import { flash } from '@/composables/useUi'
import { activeWorkspace, flattenState, setActiveWorkspaceId, toServerView } from '@/composables/useWorkspaces'
import * as api from '@/lib/api'

export { AuthRequiredError } from '@/lib/api'

export type ConnectionState = 'connecting' | 'open' | 'closed'

/** Ring buffers kept client-side for the sparklines; the API has no history. */
export interface ServerSeries {
  cpu: number[]
  rss: number[]
  probe: number[]
}

const MAX_CLIENT_LINES = 1000
const SERIES_LENGTH = 48

const appState = ref<FlatAppState | null>(null)
const workspaceSettings = ref<WorkspaceSettings | null>(null)
const connection = ref<ConnectionState>('connecting')
const lastError = ref<string | null>(null)
const now = ref(Date.now())
const logLines = reactive<Record<string, LogLine[]>>({})
const series = reactive<Record<string, ServerSeries>>({})
const streams = new Map<string, EventSource>()
const streamRefs = new Map<string, number>()
const lastSample = new Map<string, number>()

let globalSource: EventSource | null = null
let clock: ReturnType<typeof setInterval> | null = null

/** The pinned workspace, or null before the first frame lands. */
function pinnedWorkspace(): string | null {
  return appState.value?.workspaceId ?? null
}

function pushCapped(ring: number[], value: number): void {
  ring.push(value)
  if (ring.length > SERIES_LENGTH)
    ring.splice(0, ring.length - SERIES_LENGTH)
}

function seriesFor(id: string): ServerSeries {
  return series[id] ?? (series[id] = { cpu: [], rss: [], probe: [] })
}

function sampleServer(server: ServerView): void {
  const at = server.resources?.sampledAt ?? server.startedAt ?? 0
  if (lastSample.get(server.id) === at)
    return
  lastSample.set(server.id, at)
  const ring = seriesFor(server.id)
  pushCapped(ring.cpu, server.resources?.cpuPercent ?? 0)
  pushCapped(ring.rss, server.resources?.rssBytes ?? 0)
  pushCapped(ring.probe, server.responseMs ?? 0)
}

function appendLines(serverId: string, lines: LogLine[]): void {
  const bucket = logLines[serverId] ?? (logLines[serverId] = [])
  bucket.push(...lines)
  if (bucket.length > MAX_CLIENT_LINES)
    bucket.splice(0, bucket.length - MAX_CLIENT_LINES)
}

/**
 * Replaces the flat snapshot from a raw `AppState`, re-deriving every flattened
 * field. `activeWorkspaceId` is synced first so the scoped API calls this frame
 * triggers (log streams, settings writes) target the same workspace the UI shows.
 */
function setRawState(state: Parameters<typeof flattenState>[0]): void {
  setActiveWorkspaceId(state.workspaces[0]?.id)
  const flat = flattenState(state)
  setActiveWorkspaceId(flat.workspaceId)
  appState.value = flat
  for (const server of flat.servers)
    sampleServer(server)
}

function upsertServer(server: ServerView): void {
  const current = appState.value
  if (!current)
    return
  const workspaceId = server.workspaceId ?? current.workspaceId
  // The raw workspaces are the source of truth; the flat list is derived from them.
  const target = current.workspaces.find(workspace => workspace.id === workspaceId)
  if (target) {
    const index = target.servers.findIndex(entry => entry.id === server.id)
    if (index === -1)
      target.servers.push(server)
    else target.servers[index] = server
    if (workspaceId === current.workspaceId) {
      current.servers = current.workspaces.flatMap(workspace =>
        workspace.servers.map(entry => toServerView(entry, workspace.id)),
      )
    }
  }
  else {
    const index = current.servers.findIndex(entry => entry.id === server.id)
    if (index === -1) {
      current.servers = [...current.servers, { ...server, workspaceId: workspaceId ?? undefined }]
    }
    else {
      current.servers = current.servers.map(entry =>
        entry.id === server.id ? { ...server, workspaceId: workspaceId ?? entry.workspaceId } : entry,
      )
    }
  }
  sampleServer(server)
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
    if (parsed.state)
      setRawState(parsed.state)
    return
  }

  if (parsed.type === 'server' && parsed.server) {
    upsertServer(parsed.server as ServerView)
    return
  }

  if (parsed.type === 'log' && parsed.serverId && parsed.lines) {
    appendLines(parsed.serverId, parsed.lines)
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

/** Lazily opens a per-server stream; the server replays its ring buffer first. */
export function watchLogs(serverId: string, workspace?: string | null): LogLine[] {
  const refs = (streamRefs.get(serverId) ?? 0) + 1
  streamRefs.set(serverId, refs)
  if (refs === 1 && !streams.has(serverId)) {
    logLines[serverId] ??= []
    const source = new EventSource(api.serverStreamUrl(serverId, workspace ?? pinnedWorkspace()))
    const listener = (message: MessageEvent<string>): void => handleMessage(message.data)
    for (const event of ['log', 'server'] as const) source.addEventListener(event, listener)
    source.onerror = () => {
      // EventSource retries on its own; nothing to do beyond keeping the UI honest.
    }
    streams.set(serverId, source)
  }
  return logLines[serverId] ?? []
}

/** Closes the stream once no pane is watching it any more. */
export function unwatchLogs(serverId: string): void {
  const refs = (streamRefs.get(serverId) ?? 1) - 1
  if (refs > 0) {
    streamRefs.set(serverId, refs)
    return
  }
  streamRefs.delete(serverId)
  streams.get(serverId)?.close()
  streams.delete(serverId)
}

export function resetLogs(serverId: string): void {
  const bucket = logLines[serverId]
  if (bucket)
    bucket.splice(0, bucket.length)
  else logLines[serverId] = []
}

export function useControlPlane() {
  const servers = computed<ServerView[]>(() => appState.value?.servers ?? [])
  const configError = computed(() => appState.value?.configError ?? null)
  const configPath = computed(() => appState.value?.configPath ?? null)
  const logsDir = computed(() => appState.value?.logsDir ?? null)
  const workspaceId = computed(() => appState.value?.workspaceId ?? null)
  const control = computed(() => appState.value?.control ?? null)
  const defaults = computed(() => appState.value?.defaults ?? null)
  const logs = computed(() => workspaceSettings.value?.logs ?? appState.value?.logs ?? null)
  const notifications = computed(() => workspaceSettings.value?.notifications ?? appState.value?.notifications ?? null)
  const ddns = computed(() => appState.value?.ddns ?? null)
  const host = computed(() => appState.value?.host ?? null)
  const backups = computed<BackupsView | null>(() => appState.value?.backups ?? null)
  const runningCount = computed(() => servers.value.filter(server => server.status === 'running').length)

  async function readState(): Promise<void> {
    const raw = await api.fetchState()
    setRawState(raw)
    const workspace = activeWorkspace(raw)
    if (workspace)
      workspaceSettings.value = await api.fetchWorkspaceSettings(workspace.id).catch(() => null)
  }

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    lastError.value = null
    try {
      const result = await action()
      await readState()
      return result
    }
    catch (error) {
      // A 401 means the session died; send the UI back to the login view.
      if (error instanceof api.AuthRequiredError) {
        void useSession().refresh()
        return undefined
      }
      lastError.value = error instanceof Error ? error.message : String(error)
      return undefined
    }
  }

  function serverById(id: string | null): ServerView | null {
    if (id === null)
      return null
    return servers.value.find(server => server.id === id) ?? null
  }

  function seriesOf(id: string): ServerSeries {
    return seriesFor(id)
  }

  onScopeDispose(() => {
    // The singleton connection belongs to App.vue; nothing to release here.
  })

  return {
    appState: readonly(appState),
    servers,
    control,
    defaults,
    logs,
    notifications,
    ddns,
    backups,
    host,
    configError,
    configPath,
    logsDir,
    workspaceId,
    workspaceSettings: readonly(workspaceSettings),
    connection: readonly(connection),
    lastError: readonly(lastError),
    now: readonly(now),
    runningCount,
    serverById,
    seriesOf,
    refresh: () => run(async () => {}),
    start: (id: string) => run(() => api.serverAction(id, 'start')),
    stop: (id: string) => run(() => api.serverAction(id, 'stop')),
    restart: (id: string) => run(() => api.serverAction(id, 'restart')),
    startAll: () => run(() => api.startAll()),
    stopAll: () => run(() => api.stopAll()),
    setAutostart: (id: string, autostart: boolean) => run(() => api.patchServer(id, { autostart })),
    setBind: (id: string, bind: Bind) => run(() => api.patchServer(id, { bind })),
    setEnabled: (id: string, enabled: boolean) => run(() => api.patchServer(id, { enabled })),
    saveConfig: (id: string, patch: api.ServerPatchPayload) => run(() => api.patchServer(id, patch)),
    /** The panel-wide groups: listener, auth, TLS, host vitals, backups. */
    saveSettings: (patch: SettingsPatch) => run(() => api.patchSettings(patch)),
    /** The pinned workspace's own groups: server defaults, logs, notifications. */
    saveWorkspaceSettings: (patch: WorkspaceSettingsPatch) => run(() => api.patchWorkspaceSettings(patch)),
    clearLogs: (id: string) => run(async () => {
      await api.clearLogs(id)
      resetLogs(id)
    }),
    create: (payload: api.CreateServerPayload) => run(() => api.createServer(payload)),
    remove: (id: string) => run(async () => {
      await api.removeServer(id)
      unwatchLogs(id)
      delete logLines[id]
      delete series[id]
    }),
    /** Runs an action and surfaces a failure through the shared error state. */
    async act(id: string, action: 'start' | 'stop' | 'restart'): Promise<ActionResult | undefined> {
      const result = await run(() => api.serverAction(id, action))
      if (lastError.value === null) {
        const label = action === 'start' ? 'starting' : action === 'stop' ? 'stopping' : 'restarting'
        flash(`${id}: ${label}`)
      }
      else {
        flash(lastError.value, 'error')
      }
      return result
    },
  }
}
