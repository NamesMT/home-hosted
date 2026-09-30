import type { AppState, Bind, LogLine, ServerView, SettingsPatch, WorkspaceSettingsPatch } from '@shared/contracts'
import type { ActionResult, BackupsView } from '@/lib/api'
import type { ServerRef } from '@/lib/servers'
import { sseMessageSchema } from '@shared/contracts'
import { type } from 'arktype'
import { computed, reactive, readonly, ref } from 'vue'
import { useSession } from '@/composables/useSession'
import { flash } from '@/composables/useUi'
import * as api from '@/lib/api'
import { allServers as refsOf, serverKey, toServerView } from '@/lib/servers'

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

const appState = ref<AppState | null>(null)
const connection = ref<ConnectionState>('connecting')
const lastError = ref<string | null>(null)
const now = ref(Date.now())
/** Keyed `${workspaceId}/${serverId}`, never the bare id. */
const logLines = reactive<Record<string, LogLine[]>>({})
const series = reactive<Record<string, ServerSeries>>({})
const streams = new Map<string, EventSource>()
const streamRefs = new Map<string, number>()
const lastSample = new Map<string, number>()

let globalSource: EventSource | null = null
let clock: ReturnType<typeof setInterval> | null = null
let statePromise: Promise<void> | null = null

function pushCapped(ring: number[], value: number): void {
  ring.push(value)
  if (ring.length > SERIES_LENGTH)
    ring.splice(0, ring.length - SERIES_LENGTH)
}

function seriesFor(key: string): ServerSeries {
  return series[key] ?? (series[key] = { cpu: [], rss: [], probe: [] })
}

function sampleServer(server: ServerView): void {
  if (server.workspaceId === undefined)
    return
  const key = serverKey(server.workspaceId, server.id)
  const at = server.resources?.sampledAt ?? server.startedAt ?? 0
  if (lastSample.get(key) === at)
    return
  lastSample.set(key, at)
  const ring = seriesFor(key)
  pushCapped(ring.cpu, server.resources?.cpuPercent ?? 0)
  pushCapped(ring.rss, server.resources?.rssBytes ?? 0)
  pushCapped(ring.probe, server.responseMs ?? 0)
}

function appendLines(key: string, lines: LogLine[]): void {
  const bucket = logLines[key] ?? (logLines[key] = [])
  bucket.push(...lines)
  if (bucket.length > MAX_CLIENT_LINES)
    bucket.splice(0, bucket.length - MAX_CLIENT_LINES)
}

/**
 * Replaces one entry in the frame. A `server` frame carries its `workspaceId`;
 * an id that exists in exactly one workspace is unambiguous, and anything the
 * owner cannot be resolved for is dropped rather than guessed at.
 */
function upsertServer(server: ServerView): void {
  const current = appState.value
  if (!current)
    return

  const explicit = server.workspaceId
  const owners = explicit === undefined
    ? current.workspaces.filter(workspace => workspace.servers.some(entry => entry.id === server.id))
    : current.workspaces.filter(workspace => workspace.id === explicit)
  if (owners.length !== 1)
    return

  const workspace = owners[0]!
  const withWorkspace: ServerView = explicit === undefined ? { ...server, workspaceId: workspace.id } : server
  workspace.servers = workspace.servers.some(entry => entry.id === server.id)
    ? workspace.servers.map(entry => (entry.id === server.id ? withWorkspace : entry))
    : [...workspace.servers, withWorkspace]
  sampleServer(withWorkspace)
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
      setRawState(parsed.state as AppState)
    return
  }

  if (parsed.type === 'server' && parsed.server) {
    upsertServer(parsed.server as ServerView)
    return
  }

  if (parsed.type === 'log' && parsed.serverId && parsed.lines) {
    // A frame without a workspace cannot be keyed correctly, so it is dropped.
    const workspaceId = parsed.workspaceId
    if (workspaceId === undefined)
      return
    appendLines(serverKey(workspaceId, parsed.serverId), parsed.lines)
  }
}

function setRawState(state: AppState): void {
  appState.value = state
  for (const workspace of state.workspaces) {
    for (const server of workspace.servers)
      sampleServer(toServerView(server, workspace.id))
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
 * Lazily opens a per-server stream, addressed by the workspace that owns it. The
 * server replays its ring buffer first.
 */
export function watchLogs(workspaceId: string, serverId: string): LogLine[] {
  const key = serverKey(workspaceId, serverId)
  const refs = (streamRefs.get(key) ?? 0) + 1
  streamRefs.set(key, refs)
  if (refs === 1 && !streams.has(key)) {
    logLines[key] ??= []
    const source = new EventSource(api.serverStreamUrl(serverId, workspaceId))
    const listener = (message: MessageEvent<string>): void => handleMessage(message.data)
    for (const event of ['log', 'server'] as const) source.addEventListener(event, listener)
    source.onerror = () => {
      // EventSource retries on its own; nothing to do beyond keeping the UI honest.
    }
    streams.set(key, source)
  }
  return logLines[key] ?? []
}

/** Closes the stream once no pane is watching it any more. */
export function unwatchLogs(workspaceId: string, serverId: string): void {
  const key = serverKey(workspaceId, serverId)
  const refs = (streamRefs.get(key) ?? 1) - 1
  if (refs > 0) {
    streamRefs.set(key, refs)
    return
  }
  streamRefs.delete(key)
  streams.get(key)?.close()
  streams.delete(key)
}

export function resetLogs(workspaceId: string, serverId: string): void {
  const key = serverKey(workspaceId, serverId)
  const bucket = logLines[key]
  if (bucket)
    bucket.splice(0, bucket.length)
  else logLines[key] = []
}

export function useControlPlane() {
  const workspaces = computed(() => appState.value?.workspaces ?? [])
  const allServers = computed<ServerRef[]>(() => refsOf(appState.value))
  const control = computed(() => appState.value?.control ?? null)
  const host = computed(() => appState.value?.host ?? null)
  const backups = computed<BackupsView | null>(() => appState.value?.backups ?? null)
  const ui = computed(() => appState.value?.ui ?? null)
  /** Optional: a panel that predates the reverse proxy sends no `proxy` field. */
  const proxy = computed(() => appState.value?.proxy ?? null)
  const dataRoot = computed(() => appState.value?.dataRoot ?? '')
  const projectDir = computed(() => appState.value?.projectDir ?? '')

  async function readState(): Promise<void> {
    setRawState(await api.fetchState())
  }

  /** One frame is enough for a guarded deep link; concurrent callers share it. */
  async function ensureState(): Promise<void> {
    if (appState.value !== null)
      return
    statePromise ??= readState().finally(() => {
      statePromise = null
    })
    await statePromise
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

  function serverById(workspaceId: string, id: string | null): ServerView | null {
    if (id === null)
      return null
    const workspace = appState.value?.workspaces.find(entry => entry.id === workspaceId)
    const server = workspace?.servers.find(entry => entry.id === id)
    return server === undefined ? null : toServerView(server, workspaceId)
  }

  function seriesOf(workspaceId: string, id: string): ServerSeries {
    return seriesFor(serverKey(workspaceId, id))
  }

  return {
    appState: readonly(appState),
    workspaces,
    allServers,
    control,
    host,
    backups,
    ui,
    proxy,
    dataRoot,
    projectDir,
    connection: readonly(connection),
    lastError: readonly(lastError),
    now: readonly(now),
    serverById,
    seriesOf,
    ensureState,
    refresh: () => run(async () => {}),
    start: (workspaceId: string, id: string) => run(() => api.serverAction(id, 'start', workspaceId)),
    stop: (workspaceId: string, id: string) => run(() => api.serverAction(id, 'stop', workspaceId)),
    restart: (workspaceId: string, id: string) => run(() => api.serverAction(id, 'restart', workspaceId)),
    startAll: (workspaceId: string) => run(() => api.startAll(workspaceId)),
    stopAll: (workspaceId: string) => run(() => api.stopAll(workspaceId)),
    setAutostart: (workspaceId: string, id: string, autostart: boolean) => run(() => api.patchServer(id, { autostart }, workspaceId)),
    setBind: (workspaceId: string, id: string, bind: Bind) => run(() => api.patchServer(id, { bind }, workspaceId)),
    setEnabled: (workspaceId: string, id: string, enabled: boolean) => run(() => api.patchServer(id, { enabled }, workspaceId)),
    saveConfig: (workspaceId: string, id: string, patch: api.ServerPatchPayload) => run(() => api.patchServer(id, patch, workspaceId)),
    /** The panel-wide groups: listener, auth, TLS, host vitals, backups. */
    saveSettings: (patch: SettingsPatch) => run(() => api.patchSettings(patch)),
    /** One workspace's own groups: server defaults, logs, notifications. */
    saveWorkspaceSettings: (workspaceId: string, patch: WorkspaceSettingsPatch) => run(() => api.patchWorkspaceSettings(patch, workspaceId)),
    clearLogs: (workspaceId: string, id: string) => run(async () => {
      await api.clearLogs(id, workspaceId)
      resetLogs(workspaceId, id)
    }),
    create: (workspaceId: string, payload: api.CreateServerPayload) => run(() => api.createServer(payload, workspaceId)),
    remove: (workspaceId: string, id: string) => run(async () => {
      await api.removeServer(id, workspaceId)
      unwatchLogs(workspaceId, id)
      delete logLines[serverKey(workspaceId, id)]
      delete series[serverKey(workspaceId, id)]
    }),
    /** Runs an action and surfaces a failure through the shared error state. */
    async act(workspaceId: string, id: string, action: 'start' | 'stop' | 'restart'): Promise<ActionResult | undefined> {
      const result = await run(() => api.serverAction(id, action, workspaceId))
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
