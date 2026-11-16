import type { Fixture } from '../api/fixture'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFixture } from '../api/fixture'

/**
 * A scoped token is enforced **per route**, from one declaration — never inside a handler.
 *
 * Today a token is full admin, and a monitor that only reads has to hold the same credential as a
 * deploy hook. Named scopes fix that, but only if the enforcement is not a scattering of `if`s: the
 * requirement is declared once, in a map keyed by method and path, and a test walks every route in
 * the published spec and asserts each has one. That is what makes "a `read` token gets `403
 * TOKEN_SCOPE` on every non-`GET`" a fact rather than a claim.
 *
 * Session and this-machine credentials are unaffected: scopes are about **tokens**.
 */

const fixtures: Fixture[] = []

async function fixture(): Promise<Fixture> {
  const created = await makeFixture({ servers: [{ id: 'web', command: 'node' }], views: [] })
  fixtures.push(created)
  return created
}

afterEach(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

/** A token created with these scopes, and the header that carries it. */
/**
 * An account holding exactly these scopes, and the bearer header that carries it.
 *
 * The credential is `<id>:<secret>` — the id is not secret, and carrying it is what lets the panel
 * refuse a wrong id and a wrong secret by the same path.
 */
function mint(created: Fixture, scopes: Array<'read' | 'lifecycle' | 'config' | 'admin'>, workspaces?: string[]): { token: string, headers: Record<string, string> } {
  const id = `t-${scopes.join('-')}-${Math.random().toString(36).slice(2, 7)}`
  const { secret } = created.globalSecrets.createAccount({ id, label: id, scopes, ...(workspaces === undefined ? {} : { workspaces }) })
  return { token: secret, headers: { authorization: `Bearer ${id}:${secret}` } }
}

describe('an account with only read', () => {
  it('reads, and is refused every non-GET with TOKEN_SCOPE', async () => {
    const created = await fixture()
    const { headers } = mint(created, ['read'])

    expect((await created.app.request('/api/state', { headers })).status).toBe(200)
    expect((await created.app.request('/api/servers', { headers })).status).toBe(200)

    // Every write in the spec, refused with the one code a client branches on.
    for (const [method, url] of [
      ['POST', '/api/servers/web/start'],
      ['POST', '/api/servers'],
      ['PATCH', '/api/servers/web'],
      ['DELETE', '/api/servers/web'],
      ['POST', '/api/backups'],
      ['PATCH', '/api/settings'],
    ] as const) {
      const response = await created.app.request(url, { method, headers })
      expect(response.status, `${method} ${url}`).toBe(403)
      expect(await response.json(), `${method} ${url}`).toMatchObject({ code: 'TOKEN_SCOPE' })
    }
  })
})

describe('an account with lifecycle', () => {
  it('may start and stop, and may not change config', async () => {
    const created = await fixture()
    const { headers } = mint(created, ['read', 'lifecycle'])

    // Lifecycle is allowed (the fixture's fake supervisor accepts both).
    expect((await created.app.request('/api/servers/web/start', { method: 'POST', headers })).status).toBe(200)
    expect((await created.app.request('/api/servers/web/stop', { method: 'POST', headers })).status).toBe(200)

    // Config is not.
    const patch = await created.app.request('/api/servers/web', {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'nope' }),
    })
    expect(patch.status).toBe(403)
    expect(await patch.json()).toMatchObject({ code: 'TOKEN_SCOPE' })
  })
})

describe('an account with config', () => {
  it('may write config and take a backup, and may not mint another account', async () => {
    const created = await fixture()
    const { headers } = mint(created, ['read', 'config'])

    expect((await created.app.request('/api/servers/web', {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'renamed' }),
    })).status).toBe(200)

    // Minting an account is `admin`, and the session-only rule still answers first for a credential.
    // This used to post to `/api/auth/tokens`, a route the accounts refactor removed — the assertion
    // passed because the scope guard refused an *undeclared* path with 403, so a test for a route
    // that no longer exists kept passing. It names the live route now.
    const minted = await created.app.request('/api/auth/accounts', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'child' }),
    })
    expect(minted.status).toBe(403)
  })
})

describe('an account with admin', () => {
  it('may do everything a token could do before', async () => {
    const created = await fixture()
    const { headers } = mint(created, ['admin'])
    expect((await created.app.request('/api/servers/web/start', { method: 'POST', headers })).status).toBe(200)
    expect((await created.app.request('/api/servers/web', {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'ok' }),
    })).status).toBe(200)
  })
})

describe('an account limited to one workspace', () => {
  it('is refused a route naming another, and allowed its own', async () => {
    const created = await makeFixture({ workspaces: [{ id: 'staging' }], servers: [{ id: 'web', command: 'node' }] })
    fixtures.push(created)
    const { headers } = mint(created, ['admin'], ['default'])

    expect((await created.app.request('/api/servers?workspace=default', { headers })).status).toBe(200)
    const other = await created.app.request('/api/servers?workspace=staging', { headers })
    expect(other.status).toBe(403)
    expect(await other.json()).toMatchObject({ code: 'TOKEN_SCOPE' })
  })

  /**
   * Omitting the key resolves to the panel's **default** workspace, and that resolution is what the
   * limit has to be applied to.
   *
   * The guard used to check `?workspace=` only when the query string carried one, so a token limited
   * to `staging` that sent no key fell through to `default` — a workspace it does not name — and
   * changed it. Measured before this test: `GET /api/servers` answered `200` with the default
   * workspace's servers, and `POST /api/servers/web/start` answered `200` having started `default`'s
   * `web`, for an account limited to `staging`. A limit that only binds when the client remembers to
   * spell it is not a limit: the default is the one workspace such a client reaches by *omitting* the
   * key, so it is the one that has to be refused. Fail closed and name the workspaces it holds.
   *
   * An empty `?workspace=` is the same request: `PanelService.requireWorkspace` treats `''` exactly
   * as it treats an absent key, so the guard has to as well or the limit is bypassed by sending it.
   */
  it('is refused a workspace-scoped route that names none, because that is the default workspace', async () => {
    const created = await makeFixture({ workspaces: [{ id: 'staging', servers: [{ id: 'stg', command: 'node' }] }], servers: [{ id: 'web', command: 'node' }] })
    fixtures.push(created)
    // Limited to `staging`, and the panel's default workspace is `default` — not in the list.
    const { headers } = mint(created, ['admin'], ['staging'])

    for (const [method, url] of [
      ['GET', '/api/servers'],
      ['GET', '/api/servers/web'],
      ['GET', '/api/logs'],
      ['GET', '/api/jobs'],
      ['POST', '/api/servers/web/start'],
      ['POST', '/api/servers/web/stop'],
      ['PATCH', '/api/servers/web'],
      ['DELETE', '/api/servers/web'],
    ] as const) {
      const response = await created.app.request(url, { method, headers })
      expect(response.status, `${method} ${url} must not fall through to the default workspace`).toBe(403)
      expect(await response.json(), `${method} ${url}`).toMatchObject({ code: 'TOKEN_SCOPE' })
    }

    // An explicitly empty `?workspace=` resolves the same way, so it is refused the same way.
    const empty = await created.app.request('/api/servers?workspace=', { headers })
    expect(empty.status).toBe(403)

    // The workspace it does name still works, unqualified and named.
    expect((await created.app.request('/api/servers?workspace=staging', { headers })).status).toBe(200)
    expect((await created.app.request('/api/jobs?workspace=staging', { headers })).status).toBe(200)
  })

  /** A panel-wide route has no workspace to narrow, so the limit must not refuse it. */
  it('still reaches the panel-wide routes, which name no workspace at all', async () => {
    const created = await makeFixture({ workspaces: [{ id: 'staging' }] })
    fixtures.push(created)
    const { headers } = mint(created, ['read'], ['staging'])

    expect((await created.app.request('/api/state', { headers })).status).toBe(200)
    expect((await created.app.request('/api/workspaces', { headers })).status).toBe(200)
    expect((await created.app.request('/api/backups', { headers })).status).toBe(200)
  })
})

describe('the declaration', () => {
  it('covers every route in the published spec', async () => {
    const created = await fixture()
    const { tokenScopesFor } = await import('#src/middleware/token-scope')
    const spec = await (await created.app.request('/openapi/spec.json', {
      headers: { authorization: `Bearer ${created.auth.apiTokenHint ?? ''}` },
    })).json().catch(() => null) as { paths?: Record<string, Record<string, unknown>> } | null
    // The spec may refuse an unauthenticated read; ask with the real credential instead.
    const withToken = spec ?? await (await created.app.request('/openapi/spec.json')).json() as { paths?: Record<string, Record<string, unknown>> }

    const missing: string[] = []
    for (const [route, methods] of Object.entries(withToken.paths ?? {})) {
      if (!route.startsWith('/api'))
        continue
      for (const method of Object.keys(methods)) {
        // `GET /openapi/*` and `GET /healthz` are not `/api`; this walk is only over `/api`.
        if (tokenScopesFor(method.toUpperCase(), route.replace(/\{[^}]+\}/g, ':x')) === null)
          missing.push(`${method.toUpperCase()} ${route}`)
      }
    }
    expect(missing, 'every /api route must declare what a token needs').toEqual([])
    expect(tokenScopesFor('GET', '/api/state')).toBe('read')
    expect(tokenScopesFor('POST', '/api/servers/:id/start')).toBe('lifecycle')
    expect(tokenScopesFor('PATCH', '/api/settings')).toBe('config')
    expect(tokenScopesFor('POST', '/api/auth/accounts')).toBe('admin')
  })

  /**
   * An unknown path is `404 NOT_FOUND`, as `docs/API.md` promises — not a credential error.
   *
   * The scope guard runs before routing, so an undeclared path fell into its "no declared token
   * scope" branch and answered `403 TOKEN_SCOPE`. A caller who mistyped a URL was told to check their
   * token. Only an authenticated caller ever saw it (the auth guard answers 401 first), which is why
   * nothing caught it — the documented contract simply was not tested.
   */
  it('answers an undeclared path as 404 NOT_FOUND, not a scope refusal', async () => {
    const created = await fixture()
    const account = mint(created, ['admin'])

    for (const [method, path] of [['GET', '/api/totally-bogus'], ['POST', '/api/nope']] as const) {
      const answer = await created.app.request(path, { method, headers: account.headers })
      expect(answer.status, `${method} ${path}`).toBe(404)
      expect(await answer.json()).toMatchObject({ code: 'NOT_FOUND' })
    }
  })
})
