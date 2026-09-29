import type { WorkspaceRuntime } from '#src/services/panel'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { WorkspaceError } from '#src/config/workspaces'

/** Every workspace-scoped route reads its target from this one query key. */
export const workspaceQuerySchema = type({ 'workspace?': 'string' })

/**
 * Resolves the workspace a request is about. Omitting it means the panel's
 * default workspace, which keeps `curl /api/servers` working the way it always
 * did on a single-workspace instance; naming one that does not exist is a 404,
 * never a silent fallback to another workspace's servers.
 */
export function requireWorkspace(select: (id?: string) => WorkspaceRuntime, id?: string): WorkspaceRuntime {
  try {
    return select(id)
  }
  catch (error) {
    if (error instanceof WorkspaceError)
      throw new DetailedError(error.message, { statusCode: 404, code: 'UNKNOWN_WORKSPACE' })
    throw error
  }
}
