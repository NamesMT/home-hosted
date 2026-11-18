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
   *
   * `'path'` is the variant for the two routes whose **subject is a workspace** rather than a request
   * inside one: `PATCH`/`DELETE /api/workspaces/:id` name it in the URL, not in `?workspace=`. A limit
   * that only read the query let a `staging`-limited account rename and delete `default`.
   *
   * `'all'` is the inverse of `false`: the route names no workspace **because it reaches every one**.
   * An archive is the whole panel, so a limited account is refused rather than checked — see the
   * backups block below for what that refused.
   */
  workspaceScoped: boolean | 'path' | 'all'
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
  'GET /api/proxy': { scope: 'read', workspaceScoped: false },
  'GET /api/backups': { scope: 'read', workspaceScoped: 'all' },
  /**
   * `config`, not `read`, even though it is a GET.
   *
   * The archive is not a reading: it holds every workspace's `secrets.json` and the panel's own
   * `.control-secrets.json` **in the clear** — account hashes, the DDNS KDF salt, Telegram tokens,
   * every server's secret environment values. Declared `read`, a monitor credential downloaded all of
   * it, which walked around every rule that keeps a secret *value* off a route (`PUT …/secrets` is
   * write-only, the views name only what is set). `config` is the scope that already owns backups —
   * it is what `POST /api/backups` needs, and "server, workspace and settings writes, and backups" is
   * how `docs/SECURITY.md` describes it — so an account that may take an archive may fetch it, and
   * one that may only read may not.
   */
  'GET /api/backups/:name/download': { scope: 'config', workspaceScoped: 'all' },
  'GET /api/host/temperature': { scope: 'read', workspaceScoped: false },
  'GET /api/auth/session': { scope: 'read', workspaceScoped: false },
  // Login and logout need **no** credential (the session route is public for the SPA's first paint),
  // so they have no scope: listed so the spec walk sees a declaration, and skipped by the guard.
  'POST /api/auth/login': { scope: 'read', workspaceScoped: false },
  'POST /api/auth/logout': { scope: 'read', workspaceScoped: false },

  // ── Lifecycle: start, stop, restart, free a port, forget logs ──────────────────────────────────
  'POST /api/servers/:id/start': { scope: 'lifecycle', workspaceScoped: true },
  'POST /api/servers/:id/stop': { scope: 'lifecycle', workspaceScoped: true },
  'POST /api/servers/:id/restart': { scope: 'lifecycle', workspaceScoped: true },
  'POST /api/servers/:id/free-port': { scope: 'lifecycle', workspaceScoped: true },
  // A deploy runs commands and restarts — lifecycle, not config: it is the same kind of act as a
  // restart, and a deploy hook exists to be given exactly that.
  'POST /api/servers/:id/deploy': { scope: 'lifecycle', workspaceScoped: true },
  // Running a job now is the same act as starting a service: it runs the entry and waits.
  // Jobs are their own domain. Reading them is `read`; running, creating, editing and removing are
  // the same kind of act as their server equivalents — a run is lifecycle, the rest config.
  'GET /api/jobs': { scope: 'read', workspaceScoped: true },
  'POST /api/jobs': { scope: 'config', workspaceScoped: true },
  'PATCH /api/jobs/:id': { scope: 'config', workspaceScoped: true },
  'DELETE /api/jobs/:id': { scope: 'config', workspaceScoped: true },
  // A job's secret values are config, like a server's: the route is write-only, and what it protects
  // is the value the run will read.
  'PUT /api/jobs/:id/secrets': { scope: 'config', workspaceScoped: true },
  'POST /api/jobs/:id/run': { scope: 'lifecycle', workspaceScoped: true },
  'POST /api/jobs/:id/stop': { scope: 'lifecycle', workspaceScoped: true },
  // A job's own log is a read, like a server's: it says what the run printed, and it is written by the
  // panel, not by the caller. Without a rule here the route answered `404 NOT_FOUND` for every
  // authenticated caller, because this guard runs before routing and refuses a path it cannot classify
  // — a route that exists, shipped unreachable.
  'GET /api/jobs/:id/log': { scope: 'read', workspaceScoped: true },
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
  // The subject of these two is a workspace itself, and it is in the path — so a limit applies, read
  // from the path rather than the query. Declared panel-wide, a `staging`-limited account renamed and
  // removed `default`. Creating one stays panel-wide: a new workspace is an addition to the panel, not
  // an act inside one somebody else owns. `GET /api/workspaces` stays panel-wide too — it is how a
  // client learns what it may name, so a selector built from it must not lose its own workspace.
  'PATCH /api/workspaces/:id': { scope: 'config', workspaceScoped: 'path' },
  'DELETE /api/workspaces/:id': { scope: 'config', workspaceScoped: 'path' },
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
  /**
   * Backups reach **every** workspace, so a workspace limit refuses them rather than narrowing them.
   *
   * They were declared panel-wide (`workspaceScoped: false`), read as "no workspace to narrow" — and
   * an archive names no `?workspace=` at all, so the limit never applied to one. Measured on a panel
   * with `default` and `staging`, an account limited to `staging`:
   *
   * - `POST /api/backups` answered `200` and the archive it got held `workspaces/default/secrets.json`
   *   verbatim, which is the workspace it may not read;
   * - `POST /api/backups/restore {name, include: ["workspace:default"], confirm}` answered `200` and
   *   rewrote `default`'s `servers.config.json` — the `marker` entry the admin had just added was
   *   gone — which is a **write** to a workspace it may not act on;
   * - `DELETE /api/backups/:name` removed the archive the admin had taken.
   *
   * `'all'` is the honest declaration: these routes are not panel-wide with nothing to narrow, they
   * are panel-wide **because they span everything**, so only an account without a limit may have
   * them. `GET /api/backups` too — it lists every archive and the capture tree of every workspace,
   * including each one's on-disk paths. An unlimited `config` account keeps all four, which is what
   * `docs/SECURITY.md` describes (`config`: "server, workspace and settings writes, and backups").
   */
  'POST /api/backups': { scope: 'config', workspaceScoped: 'all' },
  'DELETE /api/backups/:name': { scope: 'config', workspaceScoped: 'all' },
  'POST /api/backups/restore': { scope: 'config', workspaceScoped: 'all' },
  'POST /api/host/temperature': { scope: 'config', workspaceScoped: false },
  'DELETE /api/host/temperature': { scope: 'config', workspaceScoped: false },

  // ── Admin: everything a stolen token would use to take the panel over ──────────────────────────
  'POST /api/settings/ui': { scope: 'admin', workspaceScoped: false },
  'DELETE /api/settings/ui': { scope: 'admin', workspaceScoped: false },
  'POST /api/settings/tls': { scope: 'admin', workspaceScoped: false },
  'DELETE /api/settings/tls': { scope: 'admin', workspaceScoped: false },
  'DELETE /api/auth/password': { scope: 'admin', workspaceScoped: false },

  // Accounts are the credential model: managing one is the most privileged act there is, and the
  // routes additionally require a **session** (a credential cannot mint another).
  'POST /api/auth/accounts': { scope: 'admin', workspaceScoped: false },
  'GET /api/auth/accounts': { scope: 'admin', workspaceScoped: false },
  'PATCH /api/auth/accounts/:id': { scope: 'admin', workspaceScoped: false },
  'DELETE /api/auth/accounts/:id': { scope: 'admin', workspaceScoped: false },
  // Changing **your own** secret is not admin: every account may rotate its own credential.
  'POST /api/auth/accounts/me/secret': { scope: 'read', workspaceScoped: false },
  'POST /api/proxy/engine': { scope: 'proxy', workspaceScoped: false },
  'POST /api/proxy/start': { scope: 'proxy', workspaceScoped: false },
  'POST /api/proxy/stop': { scope: 'proxy', workspaceScoped: false },
  'POST /api/proxy/apply': { scope: 'proxy', workspaceScoped: false },
  'POST /api/proxy/revert': { scope: 'proxy', workspaceScoped: false },
  'POST /api/proxy/routes/:id/retry-certificate': { scope: 'proxy', workspaceScoped: false },
  'PUT /api/proxy/certificates/:id': { scope: 'proxy', workspaceScoped: false },
  'DELETE /api/proxy/certificates/:id': { scope: 'proxy', workspaceScoped: false },
  'PATCH /api/proxy': { scope: 'proxy', workspaceScoped: false },
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

/**
 * The value one `:param` of a matched pattern stands for, or `null`.
 *
 * The route table is the only place a path segment's meaning is written down, so a check that needs
 * one reads it through the same matcher rather than splitting the path again at the call site — a
 * second split is how `/api/workspaces/:id` would be read positionally and drift.
 */
export function pathParam(method: string, path: string, name: string): string | null {
  const want = `${method.toUpperCase()} `
  const candidates = Object.entries(RULES)
    .filter(([candidate]) => candidate.startsWith(want))
    .sort(([left], [right]) => right.split('/').length - left.split('/').length)
  const got = path.split('/')
  for (const [candidate] of candidates) {
    const pattern = candidate.slice(want.length).split('/')
    if (pattern.length !== got.length)
      continue
    if (!matches(pattern.join('/'), path))
      continue
    const index = pattern.indexOf(`:${name}`)
    return index === -1 ? null : got[index] ?? null
  }
  return null
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

/**
 * Every declared route, for the spec and the docs.
 *
 * `workspaceScoped` keeps the three-state answer the rule now has: `true` for a route acting inside a
 * workspace named by `?workspace=`, `'path'` for one whose subject is the workspace in the URL, and
 * `false` for a panel-wide route — an entry a client renders as a boolean would misreport the middle.
 */
export function declaredTokenScopes(): Array<{ route: string, scope: ApiTokenScope, workspaceScoped: TokenScopeRule['workspaceScoped'] }> {
  return Object.entries(RULES).map(([route, rule]) => ({ route, scope: rule.scope, workspaceScoped: rule.workspaceScoped }))
}

export interface TokenScopeGuardDeps {
  /**
   * The workspace a request without `?workspace=` resolves to.
   *
   * The guard needs it because an **omitted** key is not "no workspace": `requireWorkspace`
   * resolves it to the panel's default, so that is the workspace the request will act on. A limit
   * checked only against a query key the caller remembered to send is not a limit — see the
   * refusal below.
   */
  defaultWorkspaceId: () => string
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
export function createTokenScopeGuard(deps: TokenScopeGuardDeps) {
  return async (c: Context, next: Next) => {
    const identity = c.get('identity') as AuthIdentity | undefined
    const account = identity?.account
    if (account === undefined) {
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
      // No rule names this path. `docs/API.md` promises that a path under `/api` matching no route is
      // `404 NOT_FOUND`, but this guard runs **before** routing, so every typo answered
      // `403 TOKEN_SCOPE … has no declared token scope` — a credential error for a URL that does not
      // exist, sending a caller to check a token instead of their spelling. Only an authenticated
      // caller ever saw it: the auth guard answers 401 first.
      //
      // `404` is the answer either way, and it stays fail-closed. The guard's job is that an
      // undeclared route is never *reachable*, and a 404 reaches nothing. What is given up is the
      // diagnostic: a route somebody adds without declaring it now looks like a missing route rather
      // than saying "no declared token scope". That is the lesser harm, the spec walk in
      // `test/middleware/token-scopes.test.ts` fails on the route before it ships, and
      // `src/shared/error-codes.ts` already reserves `NOT_FOUND` for exactly this.
      throw new DetailedError(`no route for ${method} ${path}`, { statusCode: 404, code: 'NOT_FOUND' })
    }
    if (!tokenAllows(account.scopes, rule.scope)) {
      throw new DetailedError(
        `this account has the ${account.scopes.join(', ')} scope${account.scopes.length === 1 ? '' : 's'} — ${method} ${path} needs \`${rule.scope}\``,
        { statusCode: 403, code: 'TOKEN_SCOPE', detail: { needed: rule.scope, held: account.scopes } },
      )
    }

    // A workspace-limited account is confined to the workspaces it names, on the routes that are
    // scoped to one. A panel-wide route has no workspace to narrow, so the limit does not apply.
    //
    // **An omitted key is not "no workspace".** `requireWorkspace` resolves it to the panel's
    // default, so that is the workspace the route will act on, and it has to be the one the limit is
    // checked against. Checking only a key the caller sent made the limit advisory: measured, an
    // account limited to `staging` sent no key, fell through to `default`, and
    // `POST /api/servers/web/start` answered `200` having started that workspace's entry — a
    // destructive act on a workspace the account does not name, by leaving a query key out. An empty
    // `?workspace=` resolves identically, so it is treated identically.
    if (rule.workspaceScoped !== false && account.workspaces !== undefined) {
      // `'all'`: the route reaches **every** workspace by design (an archive), so there is nothing to
      // check it against — a limit of any size is narrower than what it does. Refused, not narrowed.
      if (rule.workspaceScoped === 'all') {
        throw new DetailedError(
          `this account is limited to ${account.workspaces.join(', ')} — ${method} ${path} spans every workspace, and a workspace limit cannot narrow it`,
          { statusCode: 403, code: 'TOKEN_SCOPE', detail: { workspaces: account.workspaces } },
        )
      }
      // `'path'`: the workspace **is** the subject and is named in the URL. Declared panel-wide, a
      // `staging`-limited account renamed and deleted `default` — the id moved out of the query and
      // the limit stopped applying.
      if (rule.workspaceScoped === 'path') {
        const named = pathParam(method, path, 'id')
        if (named !== null && !account.workspaces.includes(named)) {
          throw new DetailedError(
            `this account is limited to ${account.workspaces.join(', ')} — it cannot act on "${named}"`,
            { statusCode: 403, code: 'TOKEN_SCOPE', detail: { workspaces: account.workspaces } },
          )
        }
      }
      else {
        const asked = c.req.query('workspace')
        const target = asked !== undefined && asked.length > 0 ? asked : deps.defaultWorkspaceId()
        if (!account.workspaces.includes(target)) {
          throw new DetailedError(
            asked === undefined || asked.length === 0
              ? `this account is limited to ${account.workspaces.join(', ')} — a request naming no workspace acts on "${target}", which it may not use`
              : `this account is limited to ${account.workspaces.join(', ')} — it cannot act on "${asked}"`,
            { statusCode: 403, code: 'TOKEN_SCOPE', detail: { workspaces: account.workspaces } },
          )
        }
      }
    }

    await next()
  }
}
