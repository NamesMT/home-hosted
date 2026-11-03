import type { WorkspaceRuntime } from '#src/services/panel'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { WorkspaceError } from '#src/config/workspaces'

/**
 * Every workspace-scoped route reads its target from this one query key.
 *
 * **Strict, like every other request schema.** ArkType is permissive by default, so a key this
 * schema did not name was silently dropped and the request ran against the **default** workspace:
 * measured on the built panel, `POST /api/servers/<id>/stop?worspace=staging` answered
 * `200 {"ok":true}` having stopped that entry in `default` — a destructive action applied to the
 * wrong workspace because of one transposed letter, with nothing naming the typo. A misspelt
 * workspace must be a refused key, never a different workspace.
 *
 * A route that reads a second query key merges its own schema with this one **as the argument**
 * (`extra.merge(workspaceQuerySchema)`): `merge` keeps the argument's `onUndeclaredKey`, so that
 * spelling inherits the rejection while the reverse would lose it.
 */
export const workspaceQuerySchema = type({ 'workspace?': 'string' }).onUndeclaredKey('reject')

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
