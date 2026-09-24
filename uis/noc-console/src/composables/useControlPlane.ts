import type { AppState, Bind, LogLine, ServerView, SettingsPatch } from '@shared/contracts'
import type { ActionResult } from '@/lib/api'
import { sseMessageSchema } from '@shared/contracts'
import { type } from 'arktype'
import { computed, onScopeDispose, reactive, readonly, ref } from 'vue'
import { useSession } from '@/composables/useSession'
import { flash } from '@/composables/useUi'
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

const appState = ref<AppState | null>(null)
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

function upsertServer(server: ServerView): void {
  const current = appState.value
  if (!current)
    return
  const index = current.servers.findIndex(entry => entry.id === server.id)
  if (index === -1)
    current.servers.push(server)
  else current.servers[index] = server
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
    if (parsed.state) {
      appState.value = parsed.state as AppState
      for (const server of appState.value.servers)
        sampleServer(server)
    }
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
export function watchLogs(serverId: string): LogLine[] {
  const refs = (streamRefs.get(serverId) ?? 0) + 1
  streamRefs.set(serverId, refs)
  if (refs === 1 && !streams.has(serverId)) {
    logLines[serverId] ??= []
    const source = new EventSource(`/api/servers/${encodeURIComponent(serverId)}/stream`)
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
  const control = computed(() => appState.value?.control ?? null)
  const defaults = computed(() => appState.value?.defaults ?? null)
  const host = computed(() => appState.value?.host ?? null)
  const runningCount = computed(() => servers.value.filter(server => server.status === 'running').length)

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    lastError.value = null
    try {
      const result = await action()
      appState.value = await api.fetchState()
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
    host,
    configError,
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
    saveSettings: (patch: SettingsPatch) => run(() => api.patchSettings(patch)),
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
