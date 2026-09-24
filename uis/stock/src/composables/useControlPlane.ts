import type { AppState, LogLine, ServerView, SettingsPatch } from '@shared/contracts'
import type { MaybeRefOrGetter, Ref } from 'vue'
import type { ServerSeries } from '@/lib/telemetry'
import { parseBind, sseMessageSchema } from '@shared/contracts'
import { type } from 'arktype'
import { computed, onScopeDispose, readonly, ref, toValue, watch } from 'vue'
import { useSession } from '@/composables/useSession'
import { useToasts } from '@/composables/useToasts'
import * as api from '@/lib/api'
import { createSeries, recordSample } from '@/lib/telemetry'

export type ConnectionState = 'connecting' | 'open' | 'closed'

/** Lines kept per server client-side; the disk tail holds the archive. */
export const MAX_CLIENT_LINES = 8000

const appState = ref<AppState | null>(null)
const connection = ref<ConnectionState>('connecting')
const lastError = ref<string | null>(null)
const now = ref(Date.now())
const series = new Map<string, ServerSeries>()
const notifier = useToasts()

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

function bufferFor(serverId: string): LogBuffer {
  const existing = buffers.get(serverId)
  if (existing)
    return existing
  const created: LogBuffer = { lines: [], version: ref(0), refs: 0, source: null }
  buffers.set(serverId, created)
  return created
}

function appendLines(serverId: string, batch: LogLine[]): void {
  const buffer = bufferFor(serverId)
  buffer.lines.push(...batch)
  const overflow = buffer.lines.length - MAX_CLIENT_LINES
  if (overflow > 0)
    buffer.lines.splice(0, overflow)
  buffer.version.value += 1
  logRevision.value += 1
}

export function liveLines(serverId: string): LogLine[] {
  return buffers.get(serverId)?.lines ?? []
}

export function resetLogs(serverId: string): void {
  const buffer = buffers.get(serverId)
  if (!buffer)
    return
  buffer.lines = []
  buffer.version.value += 1
  logRevision.value += 1
}

function seriesFor(serverId: string): ServerSeries {
  const existing = series.get(serverId)
  if (existing)
    return existing
  const created = createSeries()
  series.set(serverId, created)
  return created
}

function trackServer(server: ServerView): void {
  recordSample(seriesFor(server.id), server, Date.now())
}

function upsertServer(server: ServerView): void {
  const current = appState.value
  if (!current)
    return
  const index = current.servers.findIndex(entry => entry.id === server.id)
  if (index === -1)
    current.servers.push(server)
  else current.servers[index] = server
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
      for (const server of appState.value.servers) trackServer(server)
    }
    return
  }

  if (parsed.type === 'server' && parsed.server) {
    const server = parsed.server as ServerView
    upsertServer(server)
    trackServer(server)
    return
  }

  if (parsed.type === 'log' && parsed.serverId && parsed.lines)
    appendLines(parsed.serverId, parsed.lines)
}

function openServerStream(serverId: string, buffer: LogBuffer): void {
  const source = new EventSource(`/api/servers/${encodeURIComponent(serverId)}/stream`)
  const listener = (event: Event): void => handleMessage((event as MessageEvent<string>).data)
  for (const event of ['log', 'server'] as const)
    source.addEventListener(event, listener)
  source.onerror = () => {
    // EventSource retries on its own; the shell already shows the global link.
  }
  buffer.source = source
}

function acquireServerStream(serverId: string): void {
  const buffer = bufferFor(serverId)
  buffer.refs += 1
  if (!buffer.source)
    openServerStream(serverId, buffer)
}

function releaseServerStream(serverId: string): void {
  const buffer = buffers.get(serverId)
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
export function useServerLogs(serverId: MaybeRefOrGetter<string | null>) {
  const current = computed(() => toValue(serverId))
  let held: string | null = null

  watch(current, (id) => {
    if (held !== null && held !== id)
      releaseServerStream(held)
    held = id
    if (id !== null && id.length > 0)
      acquireServerStream(id)
  }, { immediate: true })

  onScopeDispose(() => {
    if (held !== null)
      releaseServerStream(held)
    held = null
  })

  const version = computed(() => {
    const id = current.value
    // `logRevision` is the dependency that always exists; the per-buffer counter
    // is only the value, so the first append still invalidates this.
    void logRevision.value
    return id === null ? 0 : buffers.get(id)?.version.value ?? 0
  })

  return {
    version,
    lines(): LogLine[] {
      const id = current.value
      return id === null ? [] : liveLines(id)
    },
    count: computed(() => {
      const id = current.value
      void logRevision.value
      return id === null ? 0 : buffers.get(id)?.lines.length ?? 0
    }),
    clear(): void {
      const id = current.value
      if (id !== null)
        resetLogs(id)
    },
  }
}

export function useControlPlane() {
  const servers = computed(() => appState.value?.servers ?? [])
  const control = computed(() => appState.value?.control ?? null)
  const defaults = computed(() => appState.value?.defaults ?? null)
  const host = computed(() => appState.value?.host ?? null)
  const backups = computed(() => appState.value?.backups ?? null)
  const notifications = computed(() => appState.value?.notifications ?? null)
  const logsConfig = computed(() => appState.value?.logs ?? null)
  const configError = computed(() => appState.value?.configError ?? null)

  function serverById(id: string): ServerView | undefined {
    return appState.value?.servers.find(server => server.id === id)
  }

  function seriesOf(id: string): ServerSeries {
    return seriesFor(id)
  }

  async function run<T>(
    action: () => Promise<T>,
    options: { title: string, success?: string },
  ): Promise<T | undefined> {
    lastError.value = null
    try {
      const result = await action()
      appState.value = await api.fetchState()
      if (options.success)
        notifier.success(options.success)
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
    appState: readonly(appState),
    servers,
    control,
    defaults,
    host,
    backups,
    notifications,
    logsConfig,
    configError,
    connection: readonly(connection),
    lastError: readonly(lastError),
    now: readonly(now),
    serverById,
    seriesOf,

    refresh: (title = 'Refresh failed') => run(async () => {}, { title }),
    start: (id: string) => run(() => api.serverAction(id, 'start'), { title: `Could not start ${id}` }),
    stop: (id: string) => run(() => api.serverAction(id, 'stop'), { title: `Could not stop ${id}` }),
    restart: (id: string) => run(() => api.serverAction(id, 'restart'), { title: `Could not restart ${id}` }),
    startAll: () => run(() => api.startAll(), { title: 'Could not start every server', success: 'Starting every enabled server' }),
    stopAll: () => run(() => api.stopAll(), { title: 'Could not stop every server', success: 'Stopping every server' }),
    setAutostart: (id: string, autostart: boolean) => run(() => api.patchServer(id, { autostart }), { title: `Could not change autostart for ${id}` }),
    setEnabled: (id: string, enabled: boolean) => run(() => api.patchServer(id, { enabled }), { title: `Could not change ${id}` }),
    setBind: (id: string, bind: string) => {
      const parsed = parseBind(bind)
      if (parsed === null) {
        notifier.failure(`Could not change the bind for ${id}`, `"${bind}" is not a bind value`)
        return Promise.resolve(undefined)
      }
      return run(() => api.patchServer(id, { bind: parsed }), { title: `Could not change the bind for ${id}` })
    },
    saveConfig: (id: string, patch: Record<string, unknown>) => run(() => api.patchServer(id, patch), { title: `Could not save ${id}`, success: `${id} updated` }),
    saveSettings: (patch: SettingsPatch) => run(() => api.patchSettings(patch), { title: 'Could not save the settings' }),
    clearLogs: (id: string) => run(async () => {
      await api.clearLogs(id)
      resetLogs(id)
    }, { title: `Could not clear the logs for ${id}`, success: 'Buffer cleared' }),
    create: (payload: api.CreateServerPayload) => run(() => api.createServer(payload), { title: 'Could not add the server', success: 'Server added' }),
    remove: (id: string) => run(async () => {
      await api.removeServer(id)
      releaseServerStream(id)
      buffers.delete(id)
      series.delete(id)
    }, { title: `Could not remove ${id}`, success: `${id} removed` }),
  }
}
