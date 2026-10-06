import type { AppState, ServerView, WorkspaceView } from '@shared/contracts'

/**
 * A server id is only unique inside its workspace, so every client-side map
 * (log buffers, sparkline series, stream refcounts) keys on the pair.
 */
export { serverKey } from '@shared/server-key'

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

export interface ServerRef {
  workspace: WorkspaceView
  server: ServerView
}

/** Every server of every workspace, each paired with its owner. */
export function allServers(state: AppState | null): ServerRef[] {
  if (state === null)
    return []
  return state.workspaces.flatMap(workspace =>
    workspace.servers.map(server => ({ workspace, server: toServerView(server, workspace.id) })),
  )
}
