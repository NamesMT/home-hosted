import type { Fixture } from '../api/fixture'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFixture, makeView } from '../api/fixture'

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

  /**
   * A `read` account may not download a backup archive.
   *
   * The archive is not a log or a state frame: it contains `secrets.json` for every workspace and the
   * panel's own `.control-secrets.json` **in the clear** — the account hashes, the DDNS KDF salt, the
   * Telegram tokens, every server's secret environment values. Declared `read`, `GET
   * /api/backups/:name/download` handed all of it to a monitor credential: measured with a real
   * fixture, a `read` token downloaded the archive and it contained `"API_KEY":"super-secret-…"` and
   * the `default` account's scrypt hash. That is a scope escalation in the direction the whole scoped-
   * accounts model exists to prevent — `read` is documented as "state, logs, metrics, the live feed",
   * and the panel goes to some length to make secret *values* unreachable from every route
   * (`PUT …/secrets` is write-only, `secretEnvSet` names only). Downloading the store walked around all
   * of it.
   *
   * `config` is the scope that already owns backups (`docs/SECURITY.md`: "server, workspace and
   * settings writes, and backups"), and `POST /api/backups` needs it, so an account that may write a
   * config and take an archive may also fetch it. A `read` account gets `403 TOKEN_SCOPE`.
   */
  it('may not download a backup archive, which carries the secrets store in the clear', async () => {
    const created = await makeFixture({ password: 'correct-horse-battery', servers: [{ id: 'web', command: 'node', secretEnv: ['API_KEY'] }] })
    fixtures.push(created)
    created.workspaces.get('default')!.secrets.setServerEnv('web', { API_KEY: 'super-secret-value-xyz' })

    const admin = mint(created, ['admin'])
    const created201 = await created.app.request('/api/backups', {
      method: 'POST',
      headers: { ...admin.headers, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(created201.status).toBe(200)
    const { file } = await created201.json() as { file: { name: string } }

    const reader = mint(created, ['read'])
    const refused = await created.app.request(`/api/backups/${file.name}/download`, { headers: reader.headers })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: 'TOKEN_SCOPE', detail: { needed: 'config' } })

    // The scope that owns backups still reaches it.
    const config = mint(created, ['read', 'config'])
    const allowed = await created.app.request(`/api/backups/${file.name}/download`, { headers: config.headers })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('content-type')).toBe('application/zip')
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

  /**
   * `config` reaches command execution, even though it is refused the `lifecycle` act of *running*.
   *
   * This pins the claim `docs/SECURITY.md` now makes out loud, because it is the one a person gets
   * wrong when handing a deploy pipeline a scope: a config write says *what* runs, and the panel runs
   * it without asking again. Measured on a real panel, with an account holding `read,config` and no
   * `lifecycle`:
   *
   * - `POST /api/jobs` with a `schedule` answered `201`, and one cron minute later the job's command
   *   had written its own `id` output — a shell as the panel's user;
   * - `POST /api/jobs/:id/run` for that same job answered `403 TOKEN_SCOPE`.
   *
   * So the two scopes are not "may run" and "may not run": `lifecycle` is *starting it now*, and
   * `config` is *arranging for it to start*. The route scopes are correct as declared — this test
   * exists so a future change that makes `config` stop being execution rewrites the doc rather than
   * leaving the warning standing, and so nobody "fixes" it by widening `lifecycle`.
   */
  it('can arrange for a command to run, though it may not run one directly', async () => {
    const created = await makeFixture({ servers: [{ id: 'web', command: 'node' }] })
    fixtures.push(created)
    const { headers } = mint(created, ['read', 'config'])

    // Declaring a scheduled job is `config`, and it succeeds.
    const made = await created.app.request('/api/jobs', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'arranged', command: 'true', schedule: '0 3 * * *' }),
    })
    expect(made.status).toBe(201)

    // Running it *now* is `lifecycle`, and is refused.
    const ran = await created.app.request('/api/jobs/arranged/run', { method: 'POST', headers })
    expect(ran.status).toBe(403)
    expect(await ran.json()).toMatchObject({ code: 'TOKEN_SCOPE', detail: { needed: 'lifecycle' } })

    // The same is true of a server entry: writing one is `config`, starting it is `lifecycle`.
    expect((await created.app.request('/api/servers/web', {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ autostart: true }),
    })).status).toBe(200)
    expect((await created.app.request('/api/servers/web/start', { method: 'POST', headers })).status).toBe(403)
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

  /**
   * A workspace named in the **path** is still a workspace.
   *
   * `PATCH`/`DELETE /api/workspaces/:id` are declared panel-wide (`workspaceScoped: false`), because a
   * token's workspace limit is about the `?workspace=` a route acts *inside* — but the subject of
   * these two routes is a workspace itself, and it is right there in the path. So an account limited
   * to `staging` renamed and removed `default`, a workspace it does not name: measured, `PATCH
   * /api/workspaces/default {"label":"pwned"}` answered `200` and the registry served the new label.
   * A limit that a caller escapes by moving the id from the query into the path is not a limit.
   *
   * Creating one and listing the registry stay open: a new workspace is an addition to the panel, not
   * an act inside a workspace somebody else owns, and the list is how a client learns what it *may*
   * name (it is what the UI's selector is built from). The two that act on an **existing** workspace
   * are the ones this refuses.
   */
  it('may not rename or remove a workspace it is not limited to', async () => {
    const created = await makeFixture({ workspaces: [{ id: 'staging', servers: [{ id: 'stg', command: 'node' }] }], servers: [{ id: 'web', command: 'node' }] })
    fixtures.push(created)
    const minted = mint(created, ['admin'], ['staging'])

    const patch = await created.app.request('/api/workspaces/default', {
      method: 'PATCH',
      headers: { ...minted.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'pwned' }),
    })
    expect(patch.status).toBe(403)
    expect(await patch.json()).toMatchObject({ code: 'TOKEN_SCOPE' })

    const remove = await created.app.request('/api/workspaces/default', { method: 'DELETE', headers: minted.headers })
    expect(remove.status).toBe(403)
    expect(await remove.json()).toMatchObject({ code: 'TOKEN_SCOPE' })

    // Nothing changed: the workspace is still there, under its own label.
    expect(created.panel.workspaces().map(workspace => workspace.id)).toContain('default')
    expect(created.registry.get('default')?.label).toBe('Default')

    // Its own workspace still answers, and creating one is still an addition to the panel.
    expect((await created.app.request('/api/workspaces/staging', {
      method: 'PATCH',
      headers: { ...minted.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Staging' }),
    })).status).toBe(200)
    expect((await created.app.request('/api/workspaces', { headers: minted.headers })).status).toBe(200)
  })

  /** A panel-wide route has no workspace to narrow, so the limit must not refuse it. */
  it('still reaches the panel-wide routes, which name no workspace at all', async () => {
    const created = await makeFixture({ workspaces: [{ id: 'staging' }] })
    fixtures.push(created)
    const { headers } = mint(created, ['read'], ['staging'])

    expect((await created.app.request('/api/state', { headers })).status).toBe(200)
    expect((await created.app.request('/api/workspaces', { headers })).status).toBe(200)
  })

  /**
   * The panel-wide **snapshots** carry every workspace's servers, so a limit has to narrow them too.
   *
   * `GET /api/state` and `GET /api/workspaces` declare `workspaceScoped: false` — there is no
   * `?workspace=` to narrow — and both answer `workspaces[].servers[]`, the same `ServerView`s
   * `GET /api/servers` answers. So `GET /api/servers?workspace=default` refused a `staging`-limited
   * `read` account `403 TOKEN_SCOPE` while `GET /api/workspaces` handed it `default`'s server id,
   * its `config.command`, its live pid and status, and its `configPath`/`logsDir`. Measured on a
   * fixture whose `default` holds `secret-svc`, the refused account read
   * `[{"id":"secret-svc","command":"node --api-key=SUPERSECRET","pid":4242}]` from both routes.
   *
   * That is the same sentence the metrics scrape was fixed for: "there is no `?workspace=` to narrow"
   * is about the *query*, not the data. It is worse here, because the payload is the full view rather
   * than a handful of gauges. A session or an unlimited credential still gets the whole panel, so the
   * UIs' selector and the global overview are untouched.
   */
  it('narrows the panel-wide snapshots to the workspaces a limited account names', async () => {
    const created = await makeFixture({
      workspaces: [{ id: 'staging', servers: [{ id: 'stg', command: 'node' }] }],
      servers: [{ id: 'secret-svc', command: 'node --api-key=SUPERSECRET', port: 7001 }],
      views: [makeView('secret-svc', {
        config: { id: 'secret-svc', command: 'node --api-key=SUPERSECRET', autostart: false, enabled: true, label: 'private', port: 7001, bind: 'local' } as never,
        status: 'running',
        pid: 4242,
      })],
      workspaceViews: { staging: [makeView('stg', { workspaceId: 'staging' })] },
    })
    fixtures.push(created)
    const { headers } = mint(created, ['read'], ['staging'])

    // The limit works on the route that names a workspace.
    expect((await created.app.request('/api/servers?workspace=default', { headers })).status).toBe(403)

    for (const url of ['/api/state', '/api/workspaces']) {
      const response = await created.app.request(url, { headers })
      expect(response.status, url).toBe(200)
      const body = await response.json() as { workspaces: Array<{ id: string, servers: Array<{ id: string }> }> }
      const ids = body.workspaces.map(workspace => workspace.id)
      expect(ids, `${url} must not name a workspace the account does not hold`).toEqual(['staging'])
      expect(JSON.stringify(body), `${url} must not carry another workspace's server`).not.toContain('secret-svc')
    }

    // An account with no limit keeps the whole panel, so a person's overview is unchanged.
    const unlimited = mint(created, ['read'])
    const all = await (await created.app.request('/api/workspaces', { headers: unlimited.headers })).json() as { workspaces: Array<{ id: string }> }
    expect(all.workspaces.map(workspace => workspace.id)).toEqual(['default', 'staging'])
  })

  /**
   * A panel-wide read that **labels** its samples by workspace is still narrowable, so it is narrowed.
   *
   * `GET /api/metrics` declares `workspaceScoped: false` on the reasoning "there is no `?workspace=`
   * to narrow" — true of the query, false of the data: every sample carries a `workspace` label, so
   * there was something to narrow and not narrowing it handed a `staging`-limited `read` account the
   * id, status, crash count, restarts, uptime, response time, RSS and CPU of `default`'s servers.
   * Measured on a scratch panel with `default` holding `secret-svc` and an account limited to
   * `staging`, the scrape answered:
   *
   * ```
   * hh_servers 1
   * hh_server_up{server="secret-svc",workspace="default"} 0
   * hh_server_crashes_24h{server="secret-svc",workspace="default"} 0
   * ```
   *
   * while `GET /api/servers?workspace=default` refused that same account `403 TOKEN_SCOPE`. Its
   * closest sibling is the live feed, which is declared panel-wide too and **filters its frames** to
   * the workspaces the account names — "the stream is the cheaper way to watch a workspace you may
   * not read" is the sentence that decided that one, and it applies here unchanged: a scrape is the
   * cheaper way to watch every workspace at once.
   *
   * An account with no limit keeps the whole panel, so a person's dashboard is untouched.
   */
  it('narrows the metrics scrape to the workspaces a limited account names', async () => {
    const created = await makeFixture({
      workspaces: [{ id: 'staging', servers: [{ id: 'stg', command: 'node' }] }],
      servers: [{ id: 'secret-svc', command: 'node' }],
      views: [makeView('secret-svc', { workspaceId: 'default' })],
      workspaceViews: { staging: [makeView('stg', { workspaceId: 'staging' })] },
    })
    fixtures.push(created)

    const limited = mint(created, ['read'], ['staging'])
    const scrape = await created.app.request('/api/metrics', { headers: limited.headers })
    expect(scrape.status).toBe(200)
    const text = await scrape.text()
    // Its own workspace is there…
    expect(text).toContain('workspace="staging"')
    // …and the one it may not read is not, by either label or `hh_servers`' count of them.
    expect(text, 'a staging-limited account must not see default\'s servers').not.toContain('workspace="default"')
    expect(text).not.toContain('secret-svc')
    expect(text).toContain('hh_servers 1')

    // The same refusal its sibling route gives, so the two cannot disagree about the limit.
    expect((await created.app.request('/api/servers?workspace=default', { headers: limited.headers })).status).toBe(403)

    // An unlimited credential still scrapes every workspace: a dashboard is not broken by the rule.
    const unlimited = mint(created, ['read'])
    const all = await (await created.app.request('/api/metrics', { headers: unlimited.headers })).text()
    expect(all).toContain('workspace="default"')
    expect(all).toContain('workspace="staging"')
    expect(all).toContain('hh_servers 2')
  })

  /**
   * Backups span **every** workspace, so a workspace limit refuses them instead of narrowing them.
   *
   * They were declared panel-wide (`workspaceScoped: false`), which read as "no workspace to narrow" —
   * but an archive names no `?workspace=` at all, so the limit simply never applied. Measured on a
   * panel holding `default` and `staging`, with an account limited to `staging` and the `config` scope
   * backups need:
   *
   * - `POST /api/backups` answered `200`, and the archive it produced held
   *   `workspaces/default/secrets.json` verbatim — the secret value of a workspace it may not read;
   * - `POST /api/backups/restore` with `include: ["workspace:default"]` and `confirm` answered `200`
   *   and rewrote `default`'s `servers.config.json`, silently reverting an entry the admin had just
   *   added — a destructive write to a workspace it may not act on, past every check that refuses
   *   `PATCH /api/servers/:id?workspace=default`;
   * - `DELETE /api/backups/:name` removed an archive the admin had taken.
   *
   * The honest declaration is `'all'`: not panel-wide-with-nothing-to-narrow, but panel-wide *because*
   * it covers everything, so only an account with no limit may have it. An unlimited `config` account
   * keeps all four routes — that is what `docs/SECURITY.md` means by "`config`: backups".
   */
  it('is refused the archive routes, which reach every workspace and cannot be narrowed', async () => {
    const created = await makeFixture({
      workspaces: [
        { id: 'staging', servers: [{ id: 'stg', command: 'node' }] },
        { id: 'default', servers: [{ id: 'web', command: 'node', secretEnv: ['API_KEY'] }] },
      ],
    })
    fixtures.push(created)
    created.workspaces.get('default')!.secrets.setServerEnv('web', { API_KEY: 'default-only-value' })

    const admin = mint(created, ['admin'])
    const made = await created.app.request('/api/backups', {
      method: 'POST',
      headers: { ...admin.headers, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(made.status).toBe(200)
    const { file } = await made.json() as { file: { name: string } }

    // Limited to `staging`, with the scopes every one of these routes asks for.
    const limited = mint(created, ['read', 'lifecycle', 'config'], ['staging'])
    for (const [method, url] of [
      ['GET', '/api/backups'],
      ['POST', '/api/backups'],
      ['GET', `/api/backups/${file.name}/download`],
      ['POST', '/api/backups/restore'],
      ['DELETE', `/api/backups/${file.name}`],
    ] as const) {
      const response = await created.app.request(url, { method, headers: limited.headers })
      expect(response.status, `${method} ${url}`).toBe(403)
      expect(await response.json(), `${method} ${url}`).toMatchObject({ code: 'TOKEN_SCOPE' })
    }

    // Nothing was touched: the archive is still there, and `default`'s entry still has its value.
    expect(created.backups.list().map(entry => entry.name)).toContain(file.name)
    expect(created.workspaces.get('default')!.secrets.serverEnv('web')).toEqual({ API_KEY: 'default-only-value' })

    // An account with **no** limit keeps them: `config` owns backups.
    const unlimited = mint(created, ['read', 'config'])
    expect((await created.app.request('/api/backups', { headers: unlimited.headers })).status).toBe(200)
    expect((await created.app.request(`/api/backups/${file.name}/download`, { headers: unlimited.headers })).status).toBe(200)
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
   * The walk runs **both** ways: a declaration for a route that does not exist is dead weight too.
   *
   * Only "every route has a declaration" was checked, so declarations outlived their routes and the
   * table kept claiming things the panel cannot do. Six had accumulated: `GET /api/health` (health is
   * `/healthz`, outside `/api`), `GET /api/notifications` (only the destination credentials and test
   * sends exist), `GET`/`POST`/`DELETE /api/tls` (the pair moved to `/api/settings/tls`), and
   * `POST /api/auth/password` (accounts replaced it; only `DELETE`, the "turn the guard off" switch,
   * remains). Measured, every one of them answers `404` for an admin credential.
   *
   * It matters beyond tidiness: a stale rule is read as documentation of a route that exists — this
   * review found the six by walking them — and it makes a *renamed* route look accounted for, because
   * the old name still passes a "is there a declaration for this path" check at the wrong path.
   */
  it('declares nothing for a route that does not exist', async () => {
    const created = await fixture()
    const { declaredTokenScopes } = await import('#src/middleware/token-scope')
    const spec = await (await created.app.request('/openapi/spec.json')).json() as { paths?: Record<string, Record<string, unknown>> }

    // Both sides normalise their parameters: the table spells them `:id`, the spec `{id}`.
    const normalise = (path: string): string => path.replace(/\{[^}]+\}/g, ':p').replace(/:[A-Z_]\w*/gi, ':p')
    const real = new Set<string>()
    for (const [route, methods] of Object.entries(spec.paths ?? {})) {
      for (const method of Object.keys(methods)) {
        if (method !== 'parameters')
          real.add(`${method.toUpperCase()} ${normalise(route)}`)
      }
    }

    const orphans = declaredTokenScopes()
      .map(entry => entry.route)
      .filter(route => !real.has(normalise(route)))
    expect(orphans, 'a declared route that no longer exists is a stale rule').toEqual([])
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
