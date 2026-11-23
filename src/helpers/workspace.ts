import type { Context } from 'hono'
import type { AuthIdentity } from '#src/services/auth'
import type { WorkspaceRuntime } from '#src/services/panel'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { WorkspaceError } from '#src/config/workspaces'
import { lazy } from '#src/shared/lazy'

/**
 * Every workspace-scoped route reads its target from this one query key.
 *
 * **Strict, like every other request schema.** ArkType is permissive by default, so a key this schema
 * did not name was silently dropped and the request ran against the **default** workspace:
 * `POST /api/servers/<id>/stop?worspace=staging` answered `200 {"ok":true}` having stopped that entry
 * in `default` — a destructive action applied to the wrong workspace because of one transposed letter.
 * A misspelt workspace must be a refused key, never a different workspace.
 *
 * A route that reads a second query key merges its own schema with this one **as the argument**
 * (`extra.merge(workspaceQuerySchema)`): `merge` keeps the argument's `onUndeclaredKey`, so that
 * spelling inherits the rejection while the reverse would lose it.
 */
export const workspaceQuerySchema = lazy(() => type({ 'workspace?': 'string' }).onUndeclaredKey('reject'))

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

/**
 * The workspaces a credential may read, or `null` for "no narrowing".
 *
 * The token-scope guard enforces a limit on the routes that **name** a workspace — `?workspace=` or
 * a path segment. A panel-wide route names none, so the guard's `workspaceScoped: false` says "there
 * is nothing to check it against", and that is right about the request. It is wrong about the
 * answer whenever the answer is labelled per workspace: such a route is the cheaper way to watch a
 * workspace the account may not poll, which is the sentence `GET /api/events` and `GET /api/metrics`
 * were both fixed for.
 *
 * So a panel-wide route that publishes per-workspace data asks this instead of declaring itself
 * narrow and doing nothing. One definition, read from the identity the auth guard already resolved,
 * so the guard, the feed, the scrape and the snapshots cannot disagree about who may see what.
 *
 * `null` means no narrowing: this machine with auth unarmed, and any credential whose account names
 * no limit. A **session** of a limited account is narrowed too, exactly as the guard refuses it the
 * same routes a limited token is refused — otherwise signing in would be the way around the limit.
 */
export function workspaceLimit(c: Context): string[] | null {
  // The auth guard resolved the credential and stored it, so this is the same answer it gave: a
  // second `requestIdentity` would slide the session, which a long-lived stream must not do.
  const identity = (c.get as (key: string) => unknown)('identity') as AuthIdentity | undefined
  return identity?.account?.workspaces ?? null
}

/** Whether this credential may read one workspace, given its limit (or `null` for no limit). */
export function limitAllows(limit: string[] | null, workspaceId: string): boolean {
  return limit === null || limit.includes(workspaceId)
}
