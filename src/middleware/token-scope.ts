import type { Context, Next } from 'hono'
import type { ApiTokenScope } from '#src/config/secrets'
import type { AuthIdentity } from '#src/services/auth'
import { DetailedError } from '@namesmt/utils'
import { PUBLIC_API_PATHS } from '#src/middleware/auth'

/**
 * What an API token needs for each route — **declared once**, never inside a handler.
 *
 * A token used to be full admin, so a monitor that only reads held the same credential as a deploy
 * hook, and nothing could tell them apart. Named scopes fix that only if the requirement is not a
 * scattering of `if`s across forty handlers: this is a map keyed by method and path pattern, and
 * `test/middleware/token-scopes.test.ts` walks every `/api` route in the published spec and fails on
 * one that is missing here. A new route therefore cannot ship without a scope.
 *
 * Patterns are the panel's own spelling (`/api/servers/:id/start`), matched with `:param` segments
 * standing for any one segment — the same shape `src/app.ts` mounts.
 *
 * The four scopes are cumulative: `admin` implies the rest, `config` implies `read` for the routes it
 * writes, and a GET is `read` unless reading it is itself an admin act (a token listing).
 */

/** The requirement for one route: what a token must have, and whether a workspace limit applies. */
export interface TokenScopeRule {
  scope: ApiTokenScope
  /**
   * `true` when the route is scoped to a workspace and a token's `workspaces` limit applies.
   * Panel-wide routes (`/api/settings`, `/api/auth/*`, `/api/proxy`) are not — there is no workspace
   * to narrow, so listing one as limited would be a rule that never fires.
   */
  workspaceScoped: boolean
}

/**
 * Every `/api` route, by `"METHOD /pattern"`.
 *
 * `null` is a real answer in one place only: `GET /healthz` is outside `/api` and needs no token at
 * all. The walk test skips non-`/api` paths for that reason.
 */
const RULES: Record<string, TokenScopeRule> = {
  // ── Reads: the whole snapshot, the live feed, logs, metrics ────────────────────────────────────
  'GET /api/state': { scope: 'read', workspaceScoped: false },
  'GET /api/meta': { scope: 'read', workspaceScoped: false },
  'GET /api/events': { scope: 'read', workspaceScoped: false },
  'GET /api/health': { scope: 'read', workspaceScoped: false },
  'GET /api/metrics': { scope: 'read', workspaceScoped: false },
  'GET /api/logs': { scope: 'read', workspaceScoped: true },
  'GET /api/logs/:id': { scope: 'read', workspaceScoped: true },
  'GET /api/logs/:id/download': { scope: 'read', workspaceScoped: true },
  'GET /api/servers': { scope: 'read', workspaceScoped: true },
  'GET /api/servers/:id': { scope: 'read', workspaceScoped: true },
  'GET /api/servers/:id/logs': { scope: 'read', workspaceScoped: true },
  'GET /api/servers/:id/stream': { scope: 'read', workspaceScoped: true },
  'GET /api/workspaces': { scope: 'read', workspaceScoped: false },
  'GET /api/settings': { scope: 'read', workspaceScoped: false },
  'GET /api/settings/workspace': { scope: 'read', workspaceScoped: true },
  'GET /api/ddns': { scope: 'read', workspaceScoped: true },
  'GET /api/notifications': { scope: 'read', workspaceScoped: true },
  'GET /api/proxy': { scope: 'read', workspaceScoped: false },
  'GET /api/backups': { scope: 'read', workspaceScoped: false },
  'GET /api/backups/:name/download': { scope: 'read', workspaceScoped: false },
  'GET /api/host/temperature': { scope: 'read', workspaceScoped: false },
  'GET /api/auth/session': { scope: 'read', workspaceScoped: false },
  // Login and logout need **no** credential (the session route is public for the SPA's first paint),
  // so they have no scope: listed so the spec walk sees a declaration, and skipped by the guard.
  'POST /api/auth/login': { scope: 'read', workspaceScoped: false },
  'POST /api/auth/logout': { scope: 'read', workspaceScoped: false },
  'GET /api/tls': { scope: 'read', workspaceScoped: false },

  // ── Lifecycle: start, stop, restart, free a port, forget logs ──────────────────────────────────
  'POST /api/servers/:id/start': { scope: 'lifecycle', workspaceScoped: true },
  'POST /api/servers/:id/stop': { scope: 'lifecycle', workspaceScoped: true },
  'POST /api/servers/:id/restart': { scope: 'lifecycle', workspaceScoped: true },
  'POST /api/servers/:id/free-port': { scope: 'lifecycle', workspaceScoped: true },
  'POST /api/servers/:id/clear-logs': { scope: 'lifecycle', workspaceScoped: true },
  'POST /api/servers/start-all': { scope: 'lifecycle', workspaceScoped: true },
  'POST /api/servers/stop-all': { scope: 'lifecycle', workspaceScoped: true },
  'POST /api/servers/orphans/:id/stop': { scope: 'lifecycle', workspaceScoped: true },
  'DELETE /api/logs/:id': { scope: 'lifecycle', workspaceScoped: true },

  // ── Config: entries, workspaces, settings, backups ─────────────────────────────────────────────
  'POST /api/servers': { scope: 'config', workspaceScoped: true },
  'PUT /api/servers/:id': { scope: 'config', workspaceScoped: true },
  'PATCH /api/servers/:id': { scope: 'config', workspaceScoped: true },
  'DELETE /api/servers/:id': { scope: 'config', workspaceScoped: true },
  'PUT /api/servers/:id/secrets': { scope: 'config', workspaceScoped: true },
  'POST /api/workspaces': { scope: 'config', workspaceScoped: false },
  'PATCH /api/workspaces/:id': { scope: 'config', workspaceScoped: false },
  'DELETE /api/workspaces/:id': { scope: 'config', workspaceScoped: false },
  'PATCH /api/settings': { scope: 'config', workspaceScoped: false },
  'PATCH /api/settings/workspace': { scope: 'config', workspaceScoped: true },
  'PUT /api/ddns': { scope: 'config', workspaceScoped: true },
  'POST /api/ddns/check': { scope: 'config', workspaceScoped: true },
  'PUT /api/ddns/credentials/:id': { scope: 'config', workspaceScoped: true },
  'DELETE /api/ddns/credentials/:id': { scope: 'config', workspaceScoped: true },
  'PUT /api/notifications/destinations/:id/token': { scope: 'config', workspaceScoped: true },
  'DELETE /api/notifications/destinations/:id/token': { scope: 'config', workspaceScoped: true },
  'POST /api/notifications/destinations/:id/test': { scope: 'config', workspaceScoped: true },
  'POST /api/notifications/destinations/:id/detect-chats': { scope: 'config', workspaceScoped: true },
  'POST /api/notifications/test-webhook': { scope: 'config', workspaceScoped: true },
  'POST /api/backups': { scope: 'config', workspaceScoped: false },
  'DELETE /api/backups/:name': { scope: 'config', workspaceScoped: false },
  'POST /api/backups/restore': { scope: 'config', workspaceScoped: false },
  'POST /api/host/temperature': { scope: 'config', workspaceScoped: false },
  'DELETE /api/host/temperature': { scope: 'config', workspaceScoped: false },

  // ── Admin: everything a stolen token would use to take the panel over ──────────────────────────
  'POST /api/settings/ui': { scope: 'admin', workspaceScoped: false },
  'DELETE /api/settings/ui': { scope: 'admin', workspaceScoped: false },
  'POST /api/settings/tls': { scope: 'admin', workspaceScoped: false },
  'DELETE /api/settings/tls': { scope: 'admin', workspaceScoped: false },
  'POST /api/tls': { scope: 'admin', workspaceScoped: false },
  'DELETE /api/tls': { scope: 'admin', workspaceScoped: false },
  'POST /api/auth/password': { scope: 'admin', workspaceScoped: false },
  'DELETE /api/auth/password': { scope: 'admin', workspaceScoped: false },
  'POST /api/auth/token': { scope: 'admin', workspaceScoped: false },
  'DELETE /api/auth/token': { scope: 'admin', workspaceScoped: false },
  'POST /api/auth/tokens': { scope: 'admin', workspaceScoped: false },
  'GET /api/auth/tokens': { scope: 'admin', workspaceScoped: false },
  'DELETE /api/auth/tokens/:id': { scope: 'admin', workspaceScoped: false },
  'POST /api/proxy/engine': { scope: 'admin', workspaceScoped: false },
  'POST /api/proxy/start': { scope: 'admin', workspaceScoped: false },
  'POST /api/proxy/stop': { scope: 'admin', workspaceScoped: false },
  'POST /api/proxy/apply': { scope: 'admin', workspaceScoped: false },
  'POST /api/proxy/revert': { scope: 'admin', workspaceScoped: false },
  'POST /api/proxy/routes/:id/retry-certificate': { scope: 'admin', workspaceScoped: false },
  'PUT /api/proxy/certificates/:id': { scope: 'admin', workspaceScoped: false },
  'DELETE /api/proxy/certificates/:id': { scope: 'admin', workspaceScoped: false },
  'PATCH /api/proxy': { scope: 'admin', workspaceScoped: false },
}

/**
 * The rule for one request, or `null` when no rule names it.
 *
 * The caller decides what `null` means: the scope middleware refuses (a route with no declaration is
 * a route somebody forgot), and the spec walk uses it as the failure it is.
 *
 * Matching is exact first, then by pattern with `:param` standing for one segment — a literal beats a
 * parameterised route, so `/api/servers/start-all` can never be read as `/api/servers/:id`.
 */
export function tokenScopesFor(method: string, path: string): ApiTokenScope | null {
  const rule = ruleFor(method.toUpperCase(), path)
  return rule === null ? null : rule.scope
}

/** The full rule, for a caller that also needs to know whether a workspace limit applies. */
export function ruleFor(method: string, path: string): TokenScopeRule | null {
  const key = `${method.toUpperCase()} ${path}`
  const exact = RULES[key]
  if (exact !== undefined)
    return exact
  // Pattern order matters only between two patterns of equal length; sorted by segment count
  // descending, so `/api/servers/:id/secrets` is tried before `/api/servers/:id`.
  const candidates = Object.entries(RULES)
    .filter(([candidate]) => candidate.startsWith(`${method.toUpperCase()} `))
    .sort(([left], [right]) => right.split('/').length - left.split('/').length)
  for (const [candidate, rule] of candidates) {
    const pattern = candidate.slice(method.length + 1)
    if (matches(pattern, path))
      return rule
  }
  return null
}

/** `:param` matches exactly one non-empty segment; everything else is literal. */
function matches(pattern: string, path: string): boolean {
  const want = pattern.split('/')
  const got = path.split('/')
  if (want.length !== got.length)
    return false
  return want.every((segment, index) => segment.startsWith(':') ? (got[index] ?? '').length > 0 : segment === got[index])
}

/** Whether `held` satisfies `needed` — the scopes are cumulative, so `admin` covers everything. */
export function tokenAllows(held: readonly ApiTokenScope[], needed: ApiTokenScope): boolean {
  if (held.includes('admin'))
    return true
  if (held.includes(needed))
    return true
  // `config` and `lifecycle` both imply reading what they act on: a deploy script that may start a
  // server has to be able to see it.
  if (needed === 'read')
    return held.includes('config') || held.includes('lifecycle')
  return false
}

/** Every declared route, for the spec and the docs. */
export function declaredTokenScopes(): Array<{ route: string, scope: ApiTokenScope, workspaceScoped: boolean }> {
  return Object.entries(RULES).map(([route, rule]) => ({ route, scope: rule.scope, workspaceScoped: rule.workspaceScoped }))
}

/**
 * The guard: refuses a token whose scopes do not cover the route, and a route with no declaration.
 *
 * Runs **after** the auth guard, so `identity` is already resolved and a request with no credential
 * has been refused there. It is a no-op for a session, and for this machine with auth unarmed —
 * scopes are about **tokens**, and a person at the keyboard is not one.
 *
 * A route with no declaration is refused rather than allowed: the alternative is that the one route
 * somebody forgot is the one every token can use. The spec walk in the test is what keeps that from
 * being reachable in practice.
 */
export function createTokenScopeGuard() {
  return async (c: Context, next: Next) => {
    const identity = c.get('identity') as AuthIdentity | undefined
    const token = identity?.token
    if (token === undefined) {
      await next()
      return
    }

    const method = c.req.method.toUpperCase()
    const path = new URL(c.req.url).pathname
    // A public route never reached the credential check, so it has no scopes to enforce — and its
    // declaration exists only so the spec walk sees one.
    if (PUBLIC_API_PATHS.has(path)) {
      await next()
      return
    }
    const rule = ruleFor(method, path)
    if (rule === null) {
      throw new DetailedError(`${method} ${path} has no declared token scope`, {
        statusCode: 403,
        code: 'TOKEN_SCOPE',
      })
    }
    if (!tokenAllows(token.scopes, rule.scope)) {
      throw new DetailedError(
        `this API token has the ${token.scopes.join(', ')} scope${token.scopes.length === 1 ? '' : 's'} — ${method} ${path} needs \`${rule.scope}\``,
        { statusCode: 403, code: 'TOKEN_SCOPE', detail: { needed: rule.scope, held: token.scopes } },
      )
    }

    // A workspace-limited token is confined to the workspaces it names, on the routes that are
    // scoped to one. A panel-wide route has no workspace to narrow, so the limit does not apply.
    if (rule.workspaceScoped && token.workspaces !== undefined) {
      const asked = c.req.query('workspace')
      if (asked !== undefined && !token.workspaces.includes(asked)) {
        throw new DetailedError(
          `this API token is limited to ${token.workspaces.join(', ')} — it cannot act on "${asked}"`,
          { statusCode: 403, code: 'TOKEN_SCOPE', detail: { workspaces: token.workspaces } },
        )
      }
    }

    await next()
  }
}
