import type { AppState, ServerView, WorkspaceView } from '@shared/contracts'
import { computed, readonly, ref } from 'vue'

/**
 * The workspace compatibility layer.
 *
 * The panel is workspace-aware now — every server, log, DDNS and notification
 * route is scoped by `?workspace=<id>` — while this UI was written when a panel
 * had exactly one config, one set of defaults and one server list. Rather than
 * restyle every view, the console pins ONE workspace (the first the panel
 * reports, which is the panel default for a single-workspace instance) and the
 * old flattened shape is derived from it.
 *
 * A workspace selector is deliberately not part of this UI; `activeWorkspaceId`
 * is the single place a future one would write.
 */

/** The workspace this UI acts on: the first one the panel reports. */
export const activeWorkspaceId = ref<string | null>(null)

/** Keeps the pin on a workspace that still exists, preferring the first. */
export function setActiveWorkspaceId(id: string | null | undefined): void {
  if (id !== null && id !== undefined && id.length > 0 && id !== activeWorkspaceId.value)
    activeWorkspaceId.value = id
}

/** The active workspace subtree, or null before the first state frame lands. */
export function activeWorkspace(state: AppState | null): WorkspaceView | null {
  if (state === null)
    return null
  const preferred = activeWorkspaceId.value
  const pinned = preferred === null ? undefined : state.workspaces.find(workspace => workspace.id === preferred)
  return pinned ?? state.workspaces[0] ?? null
}

/**
 * The flattened snapshot the console's views already expect. `servers` is every
 * server of every workspace — each one carries its `workspaceId` — while the
 * single-workspace fields come from the pinned workspace.
 */
export interface FlatAppState {
  control: AppState['control']
  host: AppState['host']
  backups: AppState['backups']
  ui: AppState['ui']
  workspaces: AppState['workspaces']
  projectDir: string
  dataRoot: string
  version?: string
  servers: ServerView[]
  configError: string | null
  configPath: string | null
  defaults: WorkspaceView['defaults'] | null
  logs: WorkspaceView['logs'] | null
  notifications: WorkspaceView['notifications'] | null
  ddns: WorkspaceView['ddns'] | null
  logsDir: string | null
  workspaceId: string | null
}

/**
 * The state frame's servers are typed from the request-shaped schema, where
 * `port` may be absent; the panel always sends the normalized `number | null`
 * that `ServerView` describes, so the two are reconciled here once.
 */
export function toServerView(server: WorkspaceView['servers'][number], workspaceId: string): ServerView {
  return {
    ...server,
    config: { ...server.config, port: server.config.port ?? null },
    workspaceId: server.workspaceId ?? workspaceId,
  }
}

function flattenServers(state: AppState): ServerView[] {
  return state.workspaces.flatMap(workspace =>
    workspace.servers.map(server => toServerView(server, workspace.id)),
  )
}

export function flattenState(state: AppState): FlatAppState {
  const workspace = activeWorkspace(state)
  return {
    control: state.control,
    host: state.host,
    backups: state.backups,
    ui: state.ui,
    workspaces: state.workspaces,
    projectDir: state.projectDir,
    dataRoot: state.dataRoot,
    ...(state.version === undefined ? {} : { version: state.version }),
    servers: flattenServers(state),
    configError: workspace?.configError ?? null,
    configPath: workspace?.configPath ?? null,
    defaults: workspace?.defaults ?? null,
    logs: workspace?.logs ?? null,
    notifications: workspace?.notifications ?? null,
    ddns: workspace?.ddns ?? null,
    logsDir: workspace?.logsDir ?? null,
    workspaceId: workspace?.id ?? null,
  }
}

/** Reactive flattened snapshot, for a caller that wants it on its own. */
export function useWorkspaces(state: () => AppState | null) {
  return {
    flat: computed(() => {
      const current = state()
      return current === null ? null : flattenState(current)
    }),
    activeId: readonly(activeWorkspaceId),
  }
}
