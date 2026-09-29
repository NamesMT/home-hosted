import type { Bind, LogsConfig, NotificationView, ServerDefaults, ServerView, WorkspaceSettingsPatch, WorkspaceView } from '@shared/contracts'
import { computed, readonly, ref, watch } from 'vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { flash } from '@/composables/useUi'
import * as api from '@/lib/api'
import { rememberWorkspace, selectedWorkspaceId } from '@/lib/selection'
import { toServerView } from '@/lib/servers'

/**
 * The workspace a person is looking at. One selection is shared by the whole
 * shell so the header picker, the pages and the API defaults agree, and it is
 * persisted per browser so a reload lands where it left off.
 *
 * The stored id is only a preference: a workspace can be deleted from another
 * tab (or another browser), so the selection always falls back to the panel's
 * own default — the first workspace it lists.
 */
const creating = ref(false)

export function useWorkspaces() {
  const control = useControlPlane()

  const workspaces = computed<WorkspaceView[]>(() => control.workspaces.value)

  const selected = computed<WorkspaceView | null>(() => {
    const list = workspaces.value
    return list.find(workspace => workspace.id === selectedWorkspaceId.value) ?? list[0] ?? null
  })

  const activeId = computed(() => selected.value?.id ?? '')

  // Resolution lands on a different id than the stored one only when that id no
  // longer exists; keep the persisted preference and the API default in step.
  watch(activeId, (id) => {
    if (id.length > 0 && id !== selectedWorkspaceId.value)
      rememberWorkspace(id)
  }, { immediate: true })

  function select(id: string): void {
    rememberWorkspace(id)
  }

  const servers = computed<ServerView[]>(() =>
    (selected.value?.servers ?? []).map(server => toServerView(server, activeId.value)),
  )
  const defaults = computed<ServerDefaults | null>(() => selected.value?.defaults ?? null)
  const logsConfig = computed<LogsConfig | null>(() => selected.value?.logs ?? null)
  const notifications = computed<NotificationView | null>(() => selected.value?.notifications ?? null)
  const ddns = computed(() => selected.value?.ddns ?? null)
  const configError = computed(() => selected.value?.configError ?? null)
  const configWarnings = computed(() => selected.value?.configWarnings ?? [])
  const configPath = computed(() => selected.value?.configPath ?? null)
  const settingsPath = computed(() => selected.value?.settingsPath ?? null)
  const logsDir = computed(() => selected.value?.logsDir ?? null)
  const serverCount = computed(() => selected.value?.serverCount ?? 0)
  const runningCount = computed(() => selected.value?.runningCount ?? 0)
  const crashedCount = computed(() => selected.value?.crashedCount ?? 0)

  function serverById(id: string | null): ServerView | null {
    if (id === null)
      return null
    return servers.value.find(server => server.id === id) ?? null
  }

  function seriesOf(id: string) {
    return control.seriesOf(activeId.value, id)
  }

  /** Workspace CRUD; every call re-reads the frame so the rest of the shell follows. */
  async function create(label: string): Promise<WorkspaceView | undefined> {
    creating.value = true
    try {
      const workspace = await api.createWorkspace(label.trim().length > 0 ? { label: label.trim() } : {})
      await control.refresh()
      select(workspace.id)
      flash(`workspace “${workspace.label}” created`)
      return workspace
    }
    catch (error) {
      flash(error instanceof Error ? error.message : String(error), 'error')
      return undefined
    }
    finally {
      creating.value = false
    }
  }

  async function rename(id: string, label: string): Promise<boolean> {
    try {
      await api.renameWorkspace(id, label.trim())
      await control.refresh()
      flash('workspace renamed')
      return true
    }
    catch (error) {
      flash(error instanceof Error ? error.message : String(error), 'error')
      return false
    }
  }

  async function remove(id: string): Promise<boolean> {
    try {
      await api.removeWorkspace(id)
      await control.refresh()
      flash('workspace deleted')
      return true
    }
    catch (error) {
      flash(error instanceof Error ? error.message : String(error), 'error')
      return false
    }
  }

  return {
    workspaces,
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
    ddns,
    configError,
    configWarnings,
    configPath,
    settingsPath,
    logsDir,
    serverCount,
    runningCount,
    crashedCount,
    lastError: control.lastError,

    refresh: control.refresh,
    start: (id: string) => control.start(activeId.value, id),
    stop: (id: string) => control.stop(activeId.value, id),
    restart: (id: string) => control.restart(activeId.value, id),
    startAll: () => control.startAll(activeId.value),
    stopAll: () => control.stopAll(activeId.value),
    setEnabled: (id: string, enabled: boolean) => control.setEnabled(activeId.value, id, enabled),
    setAutostart: (id: string, autostart: boolean) => control.setAutostart(activeId.value, id, autostart),
    setBind: (id: string, bind: Bind) => control.setBind(activeId.value, id, bind),
    clearLogs: (id: string) => control.clearLogs(activeId.value, id),
    saveConfig: (id: string, patch: api.ServerPatchPayload) => control.saveConfig(activeId.value, id, patch),
    saveSettings: (patch: WorkspaceSettingsPatch) => control.saveWorkspaceSettings(activeId.value, patch),
    createServer: (payload: api.CreateServerPayload) => control.create(activeId.value, payload),
    removeServer: (id: string) => control.remove(activeId.value, id),
    act: (id: string, action: 'start' | 'stop' | 'restart') => control.act(activeId.value, id, action),
  }
}
