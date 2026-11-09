import type { AppState, Bind, LogLine, ServerView, SettingsPatch, WorkspaceSettingsPatch } from '@shared/contracts'
import type { ServerSeries } from '@shared/live-series'
import type { ConnectionState } from '@shared/live-store'
import type { ActionResult, BackupsView } from '@/lib/api'
import type { ServerRef } from '@/lib/servers'
import { errorMessage } from '@shared/error-message'
import { createLiveStore } from '@shared/live-store'
import { computed, reactive, readonly, ref } from 'vue'
import { streamDecision, useSession } from '@/composables/useSession'
import { flash } from '@/composables/useUi'
import * as api from '@/lib/api'
import { allServers as refsOf, serverKey, toServerView } from '@/lib/servers'

export { AuthRequiredError } from '@/lib/api'
export type { ServerSeries } from '@shared/live-series'
export type { ConnectionState } from '@shared/live-store'

/**
 * What every action resolves to. Each caller reads its own failure here: a shared "last error"
 * was overwritten by whichever concurrent action finished last, so one toggle could report
 * another's message, or none.
 */
export type Outcome<T> = { ok: true, value: T } | { ok: false, error: string }

const MAX_CLIENT_LINES = 1000
const SERIES_LENGTH = 48

const appState = ref<AppState | null>(null)
const connection = ref<ConnectionState>('connecting')
const now = ref(Date.now())
/**
 * Keyed `${workspaceId}/${serverId}`, never the bare id. Each is the one array a pane holds, kept
 * in step with the store's buffer in place so a pane that took it once keeps seeing new lines.
 */
const logLines = reactive<Record<string, LogLine[]>>({})
/** Servers with a lifecycle action in flight, so a held key or a second click does not stack another. */
const inFlight = reactive(new Set<string>())

let clock: ReturnType<typeof setInterval> | null = null
let statePromise: Promise<void> | null = null

/** After a stream closed for good: signed out goes to login, anything else reconnects. */
async function checkSession(): Promise<boolean> {
  try {
    if (streamDecision(await api.fetchSession()) === 'login') {
      await useSession().refresh()
      return false
    }
  }
  catch {
    // Unreachable: keep retrying.
  }
  return true
}

const store = createLiveStore({
  openEventSource: url => new EventSource(url),
  eventsUrl: '/api/events?logs=0',
  serverStreamUrl: (workspaceId, serverId) => api.serverStreamUrl(serverId, workspaceId),
  state: {
    get: () => appState.value,
    set: (state) => {
      appState.value = state
    },
  },
  maxLines: MAX_CLIENT_LINES,
  seriesCapacity: SERIES_LENGTH,
  checkSession,
  onConnection: (state) => {
    connection.value = state
  },
  onLogs: (key) => {
    // Through the reactive record, never the raw array an assignment returns: that splice is untracked.
    logLines[key] ??= []
    const bucket = logLines[key]
    bucket.splice(0, bucket.length, ...store.lines(key))
  },
  observe: value => reactive(value) as typeof value,
})

export function connect(): void {
  clock ??= setInterval(() => {
    now.value = Date.now()
  }, 1000)
  store.connect()
}

export function disconnect(): void {
  store.disconnect()
  if (clock)
    clearInterval(clock)
  clock = null
}

/**
 * Lazily opens a per-server stream, addressed by the workspace that owns it. The server replays its
 * ring buffer first, and the returned array is cleared before every replay.
 */
export function watchLogs(workspaceId: string, serverId: string): LogLine[] {
  const key = serverKey(workspaceId, serverId)
  logLines[key] ??= []
  store.acquireLogs(workspaceId, serverId)
  return logLines[key]
}

/** Closes the stream once no pane is watching it any more. */
export function unwatchLogs(workspaceId: string, serverId: string): void {
  store.releaseLogs(workspaceId, serverId)
}

export function resetLogs(workspaceId: string, serverId: string): void {
  const key = serverKey(workspaceId, serverId)
  logLines[key] ??= []
  store.resetLogs(key)
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
  /** The panel-wide settings.json could not be applied. Absent on an older panel. */
  const settingsError = computed(() => appState.value?.settingsError ?? null)

  async function readState(): Promise<void> {
    store.applyState(await api.fetchState())
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

  async function run<T>(action: () => Promise<T>): Promise<Outcome<T>> {
    try {
      const value = await action()
      await readState()
      return { ok: true, value }
    }
    catch (error) {
      // A 401 means the session died; send the UI back to the login view.
      if (error instanceof api.AuthRequiredError)
        void useSession().refresh()
      return { ok: false, error: errorMessage(error) }
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
    return store.series(serverKey(workspaceId, id))
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
    settingsError,
    connection: readonly(connection),
    now: readonly(now),
    serverById,
    seriesOf,
    ensureState,
    isBusy: (workspaceId: string, id: string): boolean => inFlight.has(serverKey(workspaceId, id)),
    refresh: () => run(async () => {}),
    start: (workspaceId: string, id: string) => run(() => api.serverAction(id, 'start', workspaceId)),
    stop: (workspaceId: string, id: string) => run(() => api.serverAction(id, 'stop', workspaceId)),
    restart: (workspaceId: string, id: string) => run(() => api.serverAction(id, 'restart', workspaceId)),
    startAll: (workspaceId: string) => run(() => api.startAll(workspaceId)),
    stopAll: (workspaceId: string, options: { withPersistent?: boolean } = {}) => run(() => api.stopAll(workspaceId, options)),
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
      store.forget(workspaceId, id)
      delete logLines[serverKey(workspaceId, id)]
    }),
    /** Runs a lifecycle action and flashes its own outcome. */
    async act(workspaceId: string, id: string, action: 'start' | 'stop' | 'restart'): Promise<Outcome<ActionResult>> {
      const key = serverKey(workspaceId, id)
      inFlight.add(key)
      const outcome = await run(() => api.serverAction(id, action, workspaceId)).finally(() => inFlight.delete(key))
      if (outcome.ok) {
        const label = action === 'start' ? 'starting' : action === 'stop' ? 'stopping' : 'restarting'
        flash(`${id}: ${label}`)
      }
      else {
        flash(outcome.error, 'error')
      }
      return outcome
    },
  }
}
