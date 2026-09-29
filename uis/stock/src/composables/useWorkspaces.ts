import type { LogsConfig, NotificationView, ServerDefaults, ServerView } from '@shared/contracts'
import type { WorkspaceState } from '@/lib/api'
import { computed, readonly, ref, watch } from 'vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useToasts } from '@/composables/useToasts'
import * as api from '@/lib/api'

/**
 * The workspace a person is looking at. One selection is shared by the whole
 * shell so the header picker, the pages and the command palette agree, and it is
 * persisted per browser so a reload lands where it left off.
 *
 * The stored id is only a preference: a workspace can be deleted from another
 * tab, so the selection always falls back to the panel's own default (the first
 * workspace the panel lists).
 */
const STORAGE_KEY = 'hh.workspace'

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  }
  catch {
    return null
  }
}

function writeStored(id: string | null): void {
  try {
    if (id === null)
      localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, id)
  }
  catch {
    // A browser with storage disabled still works; the selection just is not kept.
  }
}

const selectedId = ref<string | null>(readStored())
const creating = ref(false)

export function useWorkspaces() {
  const control = useControlPlane()
  const toasts = useToasts()

  const workspaces = computed<WorkspaceState[]>(() => control.appState.value?.workspaces ?? [])

  /** The stored id when it still exists, otherwise the panel default (the first). */
  const selected = computed<WorkspaceState | null>(() => {
    const list = workspaces.value
    return list.find(workspace => workspace.id === selectedId.value) ?? list[0] ?? null
  })

  const activeId = computed(() => selected.value?.id ?? '')

  watch([workspaces, selectedId], () => {
    const list = workspaces.value
    if (list.length === 0)
      return
    const resolved = list.find(workspace => workspace.id === selectedId.value)?.id ?? list[0]!.id
    if (resolved !== selectedId.value) {
      selectedId.value = resolved
      writeStored(resolved)
    }
  }, { immediate: true })

  function select(id: string): void {
    selectedId.value = id
    writeStored(id)
  }

  const servers = computed<ServerView[]>(() => selected.value?.servers ?? [])
  const defaults = computed<ServerDefaults | null>(() => selected.value?.defaults ?? null)
  const logsConfig = computed<LogsConfig | null>(() => selected.value?.logs ?? null)
  const notifications = computed<NotificationView | null>(() => selected.value?.notifications ?? null)
  const configError = computed(() => selected.value?.configError ?? null)
  const configWarnings = computed(() => selected.value?.configWarnings ?? [])
  const logsDir = computed(() => selected.value?.logsDir ?? null)
  const serverCount = computed(() => selected.value?.serverCount ?? 0)
  const runningCount = computed(() => selected.value?.runningCount ?? 0)
  const crashedCount = computed(() => selected.value?.crashedCount ?? 0)

  function serverById(id: string): ServerView | undefined {
    return servers.value.find(server => server.id === id)
  }

  function seriesOf(id: string) {
    return control.seriesOf(activeId.value, id)
  }

  /** Workspace CRUD; every call re-reads the frame so the rest of the shell follows. */
  async function create(label: string): Promise<WorkspaceState | undefined> {
    creating.value = true
    try {
      const workspace = await api.createWorkspace(label.trim().length > 0 ? { label: label.trim() } : {})
      await control.refresh('Could not read the workspaces')
      select(workspace.id)
      toasts.success(`Workspace “${workspace.label}” created`)
      return workspace
    }
    catch (error) {
      toasts.failure('Could not create the workspace', error instanceof Error ? error.message : String(error))
      return undefined
    }
    finally {
      creating.value = false
    }
  }

  async function rename(id: string, label: string): Promise<boolean> {
    try {
      await api.renameWorkspace(id, label.trim())
      await control.refresh('Could not read the workspaces')
      toasts.success('Workspace renamed')
      return true
    }
    catch (error) {
      toasts.failure('Could not rename the workspace', error instanceof Error ? error.message : String(error))
      return false
    }
  }

  async function remove(id: string): Promise<boolean> {
    try {
      await api.deleteWorkspace(id)
      await control.refresh('Could not read the workspaces')
      toasts.success('Workspace deleted')
      return true
    }
    catch (error) {
      toasts.failure('Could not delete the workspace', error instanceof Error ? error.message : String(error))
      return false
    }
  }

  return {
    workspaces,
    selectedId: readonly(selectedId),
    selected,
    activeId,
    creating: readonly(creating),
    select,
    create,
    rename,
    remove,

    servers,
    serverById,
    seriesOf,
    defaults,
    logsConfig,
    notifications,
    configError,
    configWarnings,
    logsDir,
    serverCount,
    runningCount,
    crashedCount,

    refresh: control.refresh,
    start: (id: string) => control.start(activeId.value, id),
    stop: (id: string) => control.stop(activeId.value, id),
    restart: (id: string) => control.restart(activeId.value, id),
    startAll: () => control.startAll(activeId.value),
    stopAll: () => control.stopAll(activeId.value),
    setEnabled: (id: string, enabled: boolean) => control.setEnabled(activeId.value, id, enabled),
    setAutostart: (id: string, autostart: boolean) => control.setAutostart(activeId.value, id, autostart),
    setBind: (id: string, bind: string) => control.setBind(activeId.value, id, bind),
    freePort: (id: string) => control.freePort(activeId.value, id),
    clearLogs: (id: string) => control.clearLogs(activeId.value, id),
    saveConfig: (id: string, patch: Record<string, unknown>) => control.saveConfig(activeId.value, id, patch),
    createServer: (payload: api.CreateServerPayload) => control.create(activeId.value, payload),
    removeServer: (id: string) => control.remove(activeId.value, id),
  }
}
