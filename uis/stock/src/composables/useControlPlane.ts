import type { Outcome } from '@shared/action-outcome'
import type { AppState, LogLine, ServerView, SettingsPatch, WorkspaceSettingsPatch } from '@shared/contracts'
import type { ConnectionState } from '@shared/live-store'
import type { MaybeRefOrGetter, Ref } from 'vue'
import type { AppStateView } from '@/lib/api'
import type { ServerSeries } from '@/lib/telemetry'
import { runThenRefetch } from '@shared/action-outcome'
import { parseBind } from '@shared/contracts'
import { errorMessage } from '@shared/error-message'
import { createLiveStore } from '@shared/live-store'
/** The composite key every per-server buffer and series is stored under. */
// Imported as well as re-exported: this module calls `serverKey` itself, and a re-export does not
// bring the name into scope.
import { serverKey } from '@shared/server-key'
import { computed, onScopeDispose, reactive, readonly, ref, toValue, watch } from 'vue'
import { streamDecision, useSession } from '@/composables/useSession'
import { useToasts } from '@/composables/useToasts'
import { t } from '@/i18n'
import * as api from '@/lib/api'
import { SERIES_CAPACITY } from '@/lib/telemetry'

export type { Outcome } from '@shared/action-outcome'
export type { ConnectionState } from '@shared/live-store'

/** Lines kept per server client-side; the disk tail holds the archive. */
export const MAX_CLIENT_LINES = 8000

const appState = ref<AppStateView | null>(null)
const connection = ref<ConnectionState>('connecting')
const now = ref(Date.now())
const notifier = useToasts()

export { serverKey } from '@shared/server-key'

/**
 * Bumped on every buffer change. The store's buffers are plain, and one may not even exist when a
 * view first evaluates its version, so a single always-live counter is what makes the log views
 * re-render on the first line and on every one after it.
 */
const logRevision = ref(0)

/**
 * After a stream closed for good: a signed-out session goes to the login view (the shell's
 * `streamDecision` watch disconnects and routes), anything else — the panel still restarting —
 * reconnects.
 */
async function checkSession(): Promise<boolean> {
  try {
    if (streamDecision(await api.fetchSession()) === 'login') {
      useSession().requireLogin()
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
  serverStreamUrl: (workspaceId, serverId) => `/api/servers/${encodeURIComponent(serverId)}/stream${api.workspaceQuery(workspaceId)}`,
  state: {
    get: () => appState.value as AppState | null,
    set: (state) => {
      appState.value = state as AppStateView
    },
  },
  maxLines: MAX_CLIENT_LINES,
  seriesCapacity: SERIES_CAPACITY,
  checkSession,
  onConnection: (state) => {
    connection.value = state
  },
  onLogs: () => {
    logRevision.value += 1
  },
  observe: value => reactive(value) as typeof value,
})

let clock: ReturnType<typeof setInterval> | null = null

export function liveLines(key: string): LogLine[] {
  return store.lines(key)
}

export function resetLogs(key: string): void {
  store.resetLogs(key)
}

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
        store.releaseLogs(workspace, server)
    }
    held = key
    if (key !== null) {
      const [workspace, server] = key.split('/')
      if (workspace !== undefined && server !== undefined)
        store.acquireLogs(workspace, server)
    }
  }, { immediate: true })

  onScopeDispose(() => {
    if (held !== null) {
      const [workspace, server] = held.split('/')
      if (workspace !== undefined && server !== undefined)
        store.releaseLogs(workspace, server)
    }
    held = null
  })

  const version = computed(() => {
    const key = current.value
    // `logRevision` is the dependency that always exists; the per-buffer counter
    // is only the value, so the first append still invalidates this.
    void logRevision.value
    return key === null ? 0 : store.logVersion(key)
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
      return key === null ? 0 : store.lines(key).length
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
  /** The panel-wide settings.json could not be applied. Absent on an older panel. */
  const settingsError = computed(() => appState.value?.settingsError ?? null)

  function workspaceById(id: string) {
    return appState.value?.workspaces.find(workspace => workspace.id === id)
  }

  function serverById(workspaceId: string, id: string): ServerView | undefined {
    return workspaceById(workspaceId)?.servers.find(server => server.id === id)
  }

  function seriesOf(workspaceId: string, id: string): ServerSeries {
    return store.series(serverKey(workspaceId, id))
  }

  /**
   * Reads the frame once when nothing is loaded yet. The router guard needs the
   * workspace list to canonicalize a URL, and it runs before the shell mounts.
   */
  async function ensureState(): Promise<void> {
    if (appState.value !== null)
      return
    try {
      store.applyState(await api.fetchState() as AppState)
    }
    catch (error) {
      if (error instanceof api.AuthRequiredError)
        useSession().requireLogin()
    }
  }

  /**
   * An action, then a fresh frame, resolving to **this call's** outcome.
   *
   * There used to be one shared `lastError` that every action overwrote, so a failed Start elsewhere
   * showed in an open config editor and kept it open after its own save had succeeded. And the
   * re-read sat in the same `try` as the action, so a refresh that failed after a successful save
   * reported the save as failed. Now each caller reads its own result, and a failed refresh is its
   * own toast.
   */
  async function run<T>(
    action: () => Promise<T>,
    options: { title: string, success?: string | ((result: T) => string) },
  ): Promise<Outcome<T>> {
    const { outcome, actionError, refetchError } = await runThenRefetch(action, async () => {
      store.applyState(await api.fetchState() as AppState)
    })
    if (!outcome.ok) {
      if (actionError instanceof api.AuthRequiredError)
        useSession().requireLogin()
      else
        notifier.failure(options.title, outcome.error)
      return outcome
    }
    const message = typeof options.success === 'function' ? options.success(outcome.value) : options.success
    if (message)
      notifier.success(message)
    if (refetchError instanceof api.AuthRequiredError)
      useSession().requireLogin()
    else if (refetchError !== undefined)
      notifier.failure(t('toast.refreshFailed'), errorMessage(refetchError))
    return outcome
  }

  /** Re-reads the frame. There is no action behind it, so its own failure is the outcome. */
  async function refresh(title = t('toast.refreshFailed')): Promise<Outcome<void>> {
    try {
      store.applyState(await api.fetchState() as AppState)
      return { ok: true, value: undefined }
    }
    catch (error) {
      if (error instanceof api.AuthRequiredError)
        useSession().requireLogin()
      else
        notifier.failure(title, errorMessage(error))
      return { ok: false, error: errorMessage(error) }
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
    settingsError,
    connection: readonly(connection),
    now: readonly(now),
    workspaceById,
    ensureState,
    serverById,
    seriesOf,

    refresh,

    start: (workspaceId: string, id: string) => run(() => api.serverAction(workspaceId, id, 'start'), { title: t('toast.startFailed', { id }) }),
    stop: (workspaceId: string, id: string) => run(() => api.serverAction(workspaceId, id, 'stop'), { title: t('toast.stopFailed', { id }) }),
    restart: (workspaceId: string, id: string) => run(() => api.serverAction(workspaceId, id, 'restart'), { title: t('toast.restartFailed', { id }) }),
    startAll: (workspaceId: string) => run(() => api.startAll(workspaceId), { title: t('toast.startAllFailed'), success: t('toast.startAllStarted') }),
    /**
     * Stops a process the panel started that no entry owns any more. The workspace view reports
     * them; this is the action that makes the report fixable without a shell.
     */
    stopOrphan: (workspaceId: string, id: string) => run(() => api.stopOrphan(workspaceId, id), { title: t('toast.stopOrphanFailed', { id }), success: t('toast.stopOrphanDone') }),
    stopAll: (workspaceId: string, options: { withPersistent?: boolean } = {}) => run(() => api.stopAll(workspaceId, options), {
      title: t('toast.stopAllFailed'),
      success: t(options.withPersistent === true ? 'toast.stopAllWithPersistent' : 'toast.stopAllStarted'),
    }),
    setAutostart: (workspaceId: string, id: string, autostart: boolean) => run(() => api.patchServer(workspaceId, id, { autostart }), { title: t('toast.autostartFailed', { id }) }),
    setEnabled: (workspaceId: string, id: string, enabled: boolean) => run(() => api.patchServer(workspaceId, id, { enabled }), { title: t('toast.changeFailed', { id }) }),
    /**
     * Frees the port a blocked entry wants. The endpoint reports what it did, so
     * the toast can say whether the port actually came free.
     */
    freePort: (workspaceId: string, id: string) => run(() => api.freePort(workspaceId, id), {
      title: t('toast.freePortFailed', { id }),
      success: result => (result.free
        ? t('toast.portFree', { port: result.port, id })
        : t('toast.portHeld', { port: result.port })),
    }),
    setBind: (workspaceId: string, id: string, bind: string): Promise<Outcome<unknown>> => {
      const parsed = parseBind(bind)
      if (parsed === null) {
        const error = t('toast.bindInvalid', { bind })
        notifier.failure(t('toast.bindFailed', { id }), error)
        return Promise.resolve({ ok: false, error })
      }
      return run(() => api.patchServer(workspaceId, id, { bind: parsed }), { title: t('toast.bindFailed', { id }) })
    },
    saveConfig: (workspaceId: string, id: string, patch: Record<string, unknown>) => run(() => api.patchServer(workspaceId, id, patch), { title: t('toast.saveServerFailed', { id }), success: t('toast.serverUpdated', { id }) }),
    saveGlobalSettings: (patch: SettingsPatch) => run(() => api.patchSettings(patch), { title: t('toast.saveSettingsFailed') }),
    saveWorkspaceSettings: (workspaceId: string, patch: WorkspaceSettingsPatch) => run(() => api.patchWorkspaceSettings(workspaceId, patch), { title: t('toast.saveSettingsFailed') }),
    clearLogs: (workspaceId: string, id: string) => run(async () => {
      await api.clearLogs(workspaceId, id)
      resetLogs(serverKey(workspaceId, id))
    }, { title: t('toast.clearLogsFailed', { id }), success: t('toast.logsCleared') }),
    create: (workspaceId: string, payload: api.CreateServerPayload) => run(() => api.createServer(workspaceId, payload), { title: t('toast.addServerFailed'), success: t('toast.serverAdded') }),
    remove: (workspaceId: string, id: string) => run(async () => {
      await api.removeServer(workspaceId, id)
      store.forget(workspaceId, id)
    }, { title: t('toast.removeServerFailed', { id }), success: t('toast.serverRemoved', { id }) }),
  }
}
