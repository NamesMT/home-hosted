import type { AppState, RestorePlan } from '#src/shared/contracts'
import type { Fixture } from './fixture'
import fs from 'node:fs'
import path from 'node:path'
import { type } from 'arktype'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateApiToken, SecretsStore } from '#src/config/secrets'
import { missingServer } from '#src/helpers/action-result'
import { homeFingerprint } from '#src/helpers/paths'
import { backupLocalResponseSchema, healthResponseSchema, serverSchema } from '#src/shared/contracts'
import { makeFixture, makeView } from './fixture'

/**
 * The panel's own surface: the auth guard, the public liveness endpoint, the metrics
 * scrape, the local shutdown channel and the static UI. These are the routes a browser,
 * a monitor and `home-hosted down` all reach without the SPA.
 */

const fixtures: Fixture[] = []

async function fixture(options?: Parameters<typeof makeFixture>[0]): Promise<Fixture> {
  const created = await makeFixture(options)
  fixtures.push(created)
  return created
}

afterEach(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

async function form(app: Fixture['app'], url: string, method: string, body: unknown): Promise<Response> {
  return app.request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Writes the global API token the way `home-hosted set-token` does — another process, same state —
 * so the panel has to pick it up from the file rather than from anything this fixture set up.
 */
function setApiToken(created: Fixture, token: string): void {
  new SecretsStore(path.join(created.dir, '.hh', '.control-secrets.json'), undefined, 'global').setApiToken(token)
}

/** Signs in and returns the cookie header a browser would send back. */
async function signIn(created: Fixture, password: string): Promise<string> {
  const response = await form(created.app, '/api/auth/login', 'POST', { password })
  expect(response.status).toBe(200)
  const setCookie = response.headers.get('set-cookie')
  expect(setCookie).toContain('hh_session=')
  return setCookie!.split(';')[0]!
}

describe('auth guard', () => {
  it('demands a session for /api once a password is set', async () => {
    const created = await fixture({ password: 'correct horse' })
    const response = await created.app.request('/api/state')

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'AUTH_REQUIRED' })
  })

  it('keeps the session, login and the OpenAPI document readable before signing in', async () => {
    const created = await fixture({ password: 'correct horse' })

    expect((await created.app.request('/api/auth/session')).status).toBe(200)
    expect((await created.app.request('/openapi/spec.json')).status).toBe(200)
  })

  it('rejects a state-changing request whose Origin is another host', async () => {
    const created = await fixture()
    const response = await created.app.request('/api/servers/start-all', {
      method: 'POST',
      headers: { origin: 'http://evil.test' },
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'CROSS_ORIGIN' })
  })

  it('accepts a same-origin state-changing request', async () => {
    const created = await fixture()
    const response = await created.app.request('/api/servers/start-all', {
      method: 'POST',
      headers: { origin: 'http://localhost', host: 'localhost' },
    })

    expect(response.status).toBe(200)
  })

  it('refuses a remote caller when auth is on but no password is set', async () => {
    // Enabled-but-unarmed only trusts this machine, so the same request from the LAN
    // must not be answered.
    const local = await fixture({ ip: '127.0.0.1' })
    expect((await local.app.request('/api/state')).status).toBe(200)

    const remote = await fixture({ ip: '10.0.0.5' })
    const response = await remote.app.request('/api/state')
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'AUTH_UNARMED' })
  })

  /**
   * Auth switched off used to skip every check, so a request a reverse proxy on this machine
   * relayed (loopback peer, forwarding headers) was full admin for whoever reached that proxy.
   */
  it('with auth off, refuses anything that is not this machine — including a relayed loopback request', async () => {
    const local = await fixture()
    local.settings.updateControl({ auth: { enabled: false } })
    expect((await local.app.request('/api/state')).status).toBe(200)

    const relayed = await local.app.request('/api/state', { headers: { 'x-forwarded-for': '203.0.113.9' } })
    expect(relayed.status).toBe(401)
    expect(await relayed.json()).toMatchObject({ code: 'AUTH_DISABLED_REMOTE' })

    const remote = await fixture({ ip: '10.0.0.5' })
    remote.settings.updateControl({ auth: { enabled: false } })
    const response = await remote.app.request('/api/state')
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'AUTH_DISABLED_REMOTE' })
  })

  it('with auth off, still lets the API token through from anywhere', async () => {
    const remote = await fixture({ ip: '10.0.0.5' })
    remote.settings.updateControl({ auth: { enabled: false } })
    const token = generateApiToken()
    setApiToken(remote, token)
    expect((await remote.app.request('/api/state', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)
  })
})

describe('auth routes', () => {
  it('rejects a wrong password without a cookie', async () => {
    const created = await fixture({ password: 'correct horse' })
    const response = await form(created.app, '/api/auth/login', 'POST', { password: 'wrong' })

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'LOGIN_FAILED' })
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('exchanges the password for a session the guard accepts', async () => {
    const created = await fixture({ password: 'correct horse' })

    const cookie = await signIn(created, 'correct horse')
    const response = await created.app.request('/api/state', { headers: { cookie } })

    expect(response.status).toBe(200)
    // The config path is per workspace now; the default workspace is the one named.
    const state = await response.json() as AppState
    expect(state.dataRoot).toBe(created.dir)
    expect(state.workspaces.map(workspace => workspace.configPath)).toEqual([created.store.path])
  })

  /** An expired session is exactly when the browser most needs to be told to drop its cookie. */
  it('clears the cookie on logout even when the session already expired', async () => {
    const created = await fixture({ password: 'correct horse' })
    const cookie = await signIn(created, 'correct horse')
    created.auth.logoutAll()

    const response = await created.app.request('/api/auth/logout', { method: 'POST', headers: { cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')?.toLowerCase()).toContain('max-age=0')
  })

  it('still refuses a cross-site logout', async () => {
    const created = await fixture({ password: 'correct horse' })
    const response = await created.app.request('http://127.0.0.1:3999/api/auth/logout', { method: 'POST', headers: { origin: 'https://evil.example' } })
    expect(response.status).toBe(403)
  })

  it('clears the cookie on logout', async () => {
    const created = await fixture({ password: 'correct horse' })
    const cookie = await signIn(created, 'correct horse')

    const response = await created.app.request('/api/auth/logout', { method: 'POST', headers: { cookie } })
    expect(response.status).toBe(200)

    const cleared = response.headers.get('set-cookie')!
    expect(cleared).toContain('hh_session=')
    expect(cleared.toLowerCase()).toContain('max-age=0')

    // The session is gone, so the same cookie no longer opens /api.
    expect((await created.app.request('/api/state', { headers: { cookie } })).status).toBe(401)
  })

  it('refuses to clear a password while the panel is bound beyond loopback', async () => {
    const created = await fixture({ password: 'correct horse' })
    // Binding the LAN with no password is exactly what must stay impossible.
    created.settings.updateControl({ host: 'lan', auth: { enabled: false } })
    const cookie = await signIn(created, 'correct horse')

    const response = await created.app.request('/api/auth/password', { method: 'DELETE', headers: { cookie } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'EXPOSED_WITHOUT_PASSWORD' })
  })

  /**
   * Clearing the password is a second way authentication disappears, so the proxy's
   * exposure rule has to hold here as well: a route with `target: "panel"` serves this
   * control panel on a public hostname, and that guard only runs when a route is written.
   */
  it('refuses to clear a password while a proxy route serves the panel', async () => {
    const created = await fixture({ password: 'correct horse' })
    created.settings.updateProxy({
      enabled: true,
      routes: [{ id: 'panel', host: 'panel.lan', target: 'panel', tls: 'auto' }],
    })
    const cookie = await signIn(created, 'correct horse')

    const response = await created.app.request('/api/auth/password', { method: 'DELETE', headers: { cookie } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'PROXY_EXPOSURE_BLOCKED' })
    // The password is still there: nothing was cleared.
    expect(created.auth.passwordSet).toBe(true)
  })

  it('demands the current password to change an existing one', async () => {
    const created = await fixture({ password: 'correct horse' })
    const cookie = await signIn(created, 'correct horse')

    const missing = await created.app.request('/api/auth/password', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ newPassword: 'next password' }),
    })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ code: 'CURRENT_PASSWORD_REQUIRED' })

    const wrong = await created.app.request('/api/auth/password', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'nope', newPassword: 'next password' }),
    })
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toMatchObject({ code: 'CURRENT_PASSWORD_WRONG' })
  })

  /**
   * A short password on an exposed panel would make its next start refuse (`checkExposure` holds
   * the listener to 12 characters), so the change is refused while the panel is exposed.
   */
  it('refuses a password shorter than 12 characters while the panel is exposed', async () => {
    const created = await fixture({ password: 'correct horse' })
    created.settings.updateControl({ host: 'lan' })
    const cookie = await signIn(created, 'correct horse')

    const response = await created.app.request('/api/auth/password', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'correct horse', newPassword: 'short' }),
    })
    expect(response.status).toBe(400)
    const body = await response.json() as { code: string, message: string }
    expect(body.code).toBe('PASSWORD_TOO_SHORT')
    expect(body.message).toContain('shorter than 12 characters')
    expect(created.auth.passwordTooShort).toBe(false)
  })

  it('accepts a short password on a loopback-only panel, and flags it', async () => {
    const created = await fixture({ password: 'correct horse' })
    const cookie = await signIn(created, 'correct horse')

    const response = await created.app.request('/api/auth/password', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'correct horse', newPassword: 'short' }),
    })
    expect(response.status).toBe(200)
    expect(created.auth.passwordTooShort).toBe(true)
    // And moving the listener to the LAN is then refused with the reason.
    const moved = await created.app.request('/api/settings', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ control: { host: 'lan' } }),
    })
    expect(moved.status).toBe(400)
    expect(await moved.json()).toMatchObject({ code: 'EXPOSURE_BLOCKED' })
  })
})

describe('healthz', () => {
  it('answers anonymously with the status line only', async () => {
    const created = await fixture()
    const response = await created.app.request('/healthz')

    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(typeof body.uptimeMs).toBe('number')
    // Counts and alerts are for a signed-in caller.
    expect('servers' in body).toBe(false)
    expect('hostAlerts' in body).toBe(false)
  })

  /**
   * A CLI with no `run.json` asks `/healthz` whose panel holds its configured port: two homes may share
   * one. The answer is a fingerprint, and only for this machine — a relayed or remote caller gets none.
   */
  it('names its home to a loopback caller, and to nobody else', async () => {
    const local = await fixture({ ip: '127.0.0.1' })
    expect((await (await local.app.request('/healthz')).json() as { home?: string }).home).toBe(homeFingerprint())

    const relayed = await local.app.request('/healthz', { headers: { 'x-forwarded-for': '203.0.113.9' } })
    expect('home' in (await relayed.json() as object)).toBe(false)

    const remote = await fixture({ ip: '10.0.0.5' })
    expect('home' in (await (await remote.app.request('/healthz')).json() as object)).toBe(false)
  })

  it('reports degraded with 503 when an autostart server has crashed', async () => {
    const created = await fixture({
      views: [makeView('web', { status: 'crashed', config: { id: 'web', command: 'node', autostart: true } as never })],
    })

    const response = await created.app.request('/healthz')
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: 'degraded' })
  })

  /**
   * A crash is a crash whoever started it.
   *
   * The filter was `autostart && crashed`, so a server started by hand from the panel or the
   * API could die and `/healthz` still answered `ok` — the one case an external monitor exists
   * for. The deliberate-stop worry that motivated it does not apply: stopping sets `stopped`,
   * never `crashed`, which the next test pins.
   */
  it('reports degraded when a manually-started server has crashed', async () => {
    const created = await fixture({
      views: [makeView('web', { status: 'crashed', config: { id: 'web', command: 'node', autostart: false } as never })],
    })

    const response = await created.app.request('/healthz')
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: 'degraded' })
  })

  it('stays ok for a server someone deliberately stopped', async () => {
    // The reason `autostart` was in the filter; `stopped` already carries it, so the filter
    // can be dropped without a stopped server holding the panel degraded.
    const created = await fixture({
      views: [makeView('web', { status: 'stopped', config: { id: 'web', command: 'node', autostart: true } as never })],
    })

    expect(await (await created.app.request('/healthz')).json()).toMatchObject({ status: 'ok' })
  })

  /**
   * The panel's own give-up must degrade too, though the entry is `stopped`.
   *
   * `stopped` is the status the guard above pins as never degrading, because an operator's stop is
   * not a problem. But the panel also *stops* an entry that cannot serve once its health budget is
   * spent, and that is a broken service — `stoppedByPanel` is the only thing that tells them apart.
   */
  it('reports degraded when the panel itself gave up on a server', async () => {
    const created = await fixture({
      views: [makeView('web', { status: 'stopped', stoppedByPanel: true, config: { id: 'web', command: 'node', autostart: true } as never })],
    })

    const response = await created.app.request('/healthz')
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: 'degraded' })
  })

  /**
   * A server that is up but failing its own health check is exactly what an external
   * monitor cannot otherwise see: nothing crashed, so a crash-only rule answered `ok`
   * while the service was refusing requests.
   */
  it('reports degraded when a running server is unhealthy', async () => {
    const created = await fixture({
      views: [makeView('web', { status: 'running', health: 'unhealthy', config: { id: 'web', command: 'node', autostart: true } as never })],
    })

    const response = await created.app.request('/healthz')
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: 'degraded' })
  })

  it('stays ok for an unhealthy server that is not running', async () => {
    // `health` keeps its last value through a stop, so a deliberately stopped server must
    // not hold the panel degraded forever.
    const created = await fixture({
      views: [makeView('web', { status: 'stopped', health: 'unhealthy', config: { id: 'web', command: 'node', autostart: true } as never })],
    })

    const response = await created.app.request('/healthz')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok' })
  })

  /**
   * A `conflict` entry is a server that is down, and `/healthz` answered `ok` for it.
   *
   * The filter named `crashed`, `stoppedByPanel` and a running-unhealthy entry, but not the status
   * that means "this entry cannot start because something else holds its port". Measured on a panel
   * whose only entry was blocked: `GET /healthz` → `200 {"status":"ok"}` while `GET /_hh/usage`
   * answered `web conflict` and the card drew it in red — so a monitor watching the one endpoint
   * built for it reported a healthy home with a server down.
   */
  it('reports degraded for an entry blocked on its port', async () => {
    const created = await fixture({
      views: [makeView('web', { status: 'conflict', config: { id: 'web', command: 'node', autostart: true } as never })],
    })

    const response = await created.app.request('/healthz')
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: 'degraded' })
  })

  /**
   * The declared schema must describe **both** answers, not just the 200.
   *
   * `healthz` builds its 200 schema inline in the route, and `/openapi/spec.json` publishes it — but
   * nothing validated the body against it, and the 503 branch shares that response's `content` while
   * answering a different status. A schema that describes only the happy path is the drift this session
   * has now found three times (the error envelope's `detail`, six path helpers, a fixture's missing
   * fields).
   */
  it('answers a body its own documented schema accepts, on both statuses', async () => {
    // The route's own schema, not a transcription: a copy here could drift from the published one and
    // would then assert the wrong thing while looking like it checked the contract.
    const schema = healthResponseSchema

    const healthy = await fixture()
    const ok = await (await healthy.app.request('/healthz')).json()
    expect(schema(ok) instanceof type.errors, `200 body: ${JSON.stringify(schema(ok))}`).toBe(false)

    const degraded = await fixture({
      views: [makeView('web', { status: 'crashed', config: { id: 'web', command: 'node', autostart: true } as never })],
    })
    const bad = await (await degraded.app.request('/healthz')).json()
    expect(schema(bad) instanceof type.errors, `503 body: ${JSON.stringify(schema(bad))}`).toBe(false)
  })

  /**
   * The **published spec** has to describe the 503 the same way, not just the route's own schema.
   *
   * `finishSpec` stamps the error envelope onto every declared status ≥ 400, and `/healthz` declared
   * its 503 with a description and no `content` — so the spec told a generated monitor client to
   * expect `{ message, code }` from the one endpoint whose whole job is machine consumption, while
   * the body is the health document. A monitor built from the spec would read a degraded-but-working
   * panel as unparseable.
   */
  it('declares the health document as the 503 body, not the error envelope', async () => {
    const created = await fixture()
    const spec = await (await created.app.request('/openapi/spec.json')).json() as {
      paths: Record<string, { get: { responses: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }> } }>
    }
    const content = spec.paths['/healthz']!.get.responses['503']!.content
    expect(content, 'the 503 must declare a body').toBeDefined()
    const schema = JSON.stringify(content)
    expect(schema, 'it is the health document').toContain('uptimeMs')
    expect(schema, 'and not the error envelope').not.toContain('"code"')
  })

  it('includes the counts and host alerts for an authenticated caller', async () => {
    const created = await fixture({
      password: 'correct horse',
      views: [
        makeView('web', { status: 'running' }),
        makeView('api', { status: 'crashed', health: 'unhealthy' }),
      ],
    })
    const cookie = await signIn(created, 'correct horse')

    const body = await (await created.app.request('/healthz', { headers: { cookie } })).json() as {
      servers: { total: number, running: number, crashed: number, unhealthy: number }
      hostAlerts: string[]
    }

    expect(body.servers).toEqual({ total: 2, running: 1, crashed: 1, unhealthy: 1 })
    expect(Array.isArray(body.hostAlerts)).toBe(true)
  })
})

describe('metrics', () => {
  it('scrapes as prometheus text and omits a sample it has no reading for', async () => {
    const created = await fixture({
      views: [
        makeView('web', { status: 'running', restarts: 2, responseMs: 12, resources: { rssBytes: 1024, cpuPercent: 3.5, processes: 1, sampledAt: 0 } as never }),
        makeView('idle'),
      ],
    })

    const response = await created.app.request('/api/metrics')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')

    const text = await response.text()
    expect(text).toContain('hh_control_up 1')
    // A count of what is configured now, not a running total: `_total` is absent on purpose.
    expect(text).toContain('hh_servers 2')
    // A server id repeats across workspaces, so every sample names both.
    expect(text).toContain('hh_server_up{server="web",workspace="default"} 1')
    expect(text).toContain('hh_server_up{server="idle",workspace="default"} 0')
    expect(text).toContain('hh_server_restarts{server="web",workspace="default"} 2')
    expect(text).toContain('hh_server_response_ms{server="web",workspace="default"} 12')
    expect(text).toContain('hh_server_rss_bytes{server="web",workspace="default"} 1024')
    expect(text).toContain('hh_server_cpu_percent{server="web",workspace="default"} 3.5')

    // No reading means no series at all, not a zero that reads as "healthy".
    expect(text).not.toContain('hh_server_response_ms{server="idle"')
    expect(text).not.toContain('hh_server_rss_bytes{server="idle"')
    expect(text).not.toContain('hh_server_uptime_ratio_24h')
  })

  /**
   * A `_total` suffix is a promise, and this scrape keeps none of it.
   *
   * `hh_server_restarts_total` read as a counter — Prometheus' word for "monotonic since the
   * process started" — while its value is the budget spent on the *current* crash sequence, which
   * a start someone asked for resets to `0` (measured `2` → `0`). `rate()` over it therefore saw a
   * phantom counter reset on every operator touch, and `increase()` answers a number that never
   * happened. The rename fixed that instance; this is the class: the panel publishes snapshots,
   * not counters, so **no** series name may end in `_total` and **no** `# TYPE` may say `counter`.
   */
  it('publishes no series whose name promises a monotonic counter', async () => {
    const created = await fixture({
      views: [makeView('web', {
        status: 'running',
        restarts: 2,
        responseMs: 12,
        resources: { rssBytes: 1024, cpuPercent: 3.5, processes: 1, sampledAt: 0 } as never,
      })],
    })
    // Publish the host gauges too, so the whole scrape is on the wire, not only its per-server half.
    const view = created.panel.getState().host
    vi.spyOn(created.panel, 'getState').mockReturnValue({
      ...created.panel.getState(),
      host: { ...view, sampledAt: 1, cpus: 8, cpuUsedPercent: 5, memoryUsedPercent: 40, swapUsedPercent: 1, loadAvg: [1, 1, 1], disks: [{ path: '/', totalBytes: 100, freeBytes: 50, usedPercent: 50 }] },
    })

    const text = await (await created.app.request('/api/metrics')).text()
    const names = [...text.matchAll(/^# (?:HELP|TYPE) (\w+)/gm)].map(match => match[1]!)
    // Anti-vacuity: the scrape has to be the full one for "no counter" to mean anything.
    expect(names.length, `scrape carried no series: ${text}`).toBeGreaterThan(10)

    for (const name of names) {
      expect(name, `${name} ends in _total, which promises a counter Prometheus can rate()`).not.toMatch(/_total$/)
      expect(text, `${name} is declared a counter, but every value here is a snapshot`).not.toMatch(new RegExp(`^# TYPE ${name} counter$`, 'm'))
    }
    expect(text).toContain('# TYPE hh_server_restarts gauge')
  })

  /**
   * The suffix cannot carry the reset, so the HELP has to.
   *
   * A dashboard author reads the scrape, not the README: the exposition format puts the contract
   * beside the number, which is exactly where "a start someone asked for resets it to 0" has to be.
   */
  it('says in the HELP that a start someone asked for resets the restarts series', async () => {
    const created = await fixture({ views: [makeView('web', { restarts: 2 })] })
    const text = await (await created.app.request('/api/metrics')).text()

    const help = text.split('\n').find(line => line.startsWith('# HELP hh_server_restarts '))
    expect(help, 'the renamed series must be published with HELP text').toBeDefined()
    expect(help).toContain('resets')
    expect(help).toContain('0')
    // The old name is gone from the scrape, not merely beside the new one.
    expect(text).not.toContain('hh_server_restarts_total')
  })

  /**
   * And here is the fact that makes a `_total` name impossible for it: a manual start moves the
   * value backwards. The supervisor half is pinned where the reset happens
   * (`test/services/supervisor.test.ts`); this half pins that the route publishes the value as it
   * is — no clamping, no counter emulation in the scrape — so a later "make it monotonic here"
   * fails as well.
   */
  it('publishes the restarts value as it is when a start someone asked for ends the sequence', async () => {
    const created = await fixture({ views: [makeView('web', { restarts: 2 })] })
    const before = await (await created.app.request('/api/metrics')).text()
    expect(before).toContain('hh_server_restarts{server="web",workspace="default"} 2')

    // What `Supervisor.start()` does for a start someone asked for: `entry.restarts = 0`.
    const views = created.supervisor.views()
    views.splice(0, views.length, makeView('web', { restarts: 0 }))

    const after = await (await created.app.request('/api/metrics')).text()
    expect(after).toContain('hh_server_restarts{server="web",workspace="default"} 0')
  })

  /**
   * A host gauge the panel has never measured must not be published as a reading.
   *
   * `HostMonitor` starts from `emptyHostView()`, which reports `sampledAt: null` and every value
   * at zero, and a panel whose host vitals are switched off keeps that shape forever. A scrape of
   * it answered `hh_host_memory_used_percent 0` and `hh_host_load1_per_cpu 0.000` — on a real
   * fresh panel (6604, `host.enabled: false` from boot) measured exactly that. A dashboard reads
   * a present zero as a healthy reading, so an alert on `> 90` stays silent and the graph says the
   * box is idle. The per-server gauges already answer "no reading means no series"; the host ones
   * did not.
   */
  it('publishes no host gauge before the host has been sampled', async () => {
    const created = await fixture()
    const empty = created.panel.getState().host
    expect(empty.sampledAt, 'the fixture starts unsampled, like a booting panel').toBeNull()

    const text = await (await created.app.request('/api/metrics')).text()
    for (const name of ['hh_host_cpu_used_percent', 'hh_host_memory_used_percent', 'hh_host_swap_used_percent', 'hh_host_load1_per_cpu', 'hh_host_disk_used_percent'])
      expect(text, name).not.toContain(name)
  })

  /**
   * The host's own CPU share, which is the number a homelab dashboard actually wants.
   *
   * The state has carried `host.cpuUsedPercent` since 0.9.8, but `/api/metrics` never published
   * it — so the only host CPU figure a scraper could reach was `hh_host_load1_per_cpu`, a **count
   * of runnable tasks**, and a rule written as "CPU above 90%" against it reads 0.05 on an idle
   * 24-core box. Measured on a real panel: `hh_host_cpu_used_percent` was absent from the scrape
   * while `/api/state` reported `cpuUsedPercent: 5.38`.
   */
  it('publishes the host CPU share, and omits it on a sample with no window yet', async () => {
    const created = await fixture()
    const view = created.panel.getState().host
    const sampled = { ...view, sampledAt: 1, cpus: 8, cpuUsedPercent: 12.5, memoryUsedPercent: 60, swapUsedPercent: 5, loadAvg: [4, 3, 2] }
    vi.spyOn(created.panel, 'getState').mockReturnValue({ ...created.panel.getState(), host: sampled })

    const text = await (await created.app.request('/api/metrics')).text()
    expect(text).toContain('hh_host_cpu_used_percent 12.50')
    // The load count is not a percentage, so the per-cpu figure stays its own series.
    expect(text).toContain('hh_host_load1_per_cpu 0.500')

    // The very first sample has no interval to difference, so it answers `null` — and a null is
    // "no reading", never a zero that reads as idle.
    const first = { ...sampled, cpuUsedPercent: null }
    vi.spyOn(created.panel, 'getState').mockReturnValue({ ...created.panel.getState(), host: first })
    const fresh = await (await created.app.request('/api/metrics')).text()
    expect(fresh).not.toContain('hh_host_cpu_used_percent')
    // The rest of the sample is real, so it is still published.
    expect(fresh).toContain('hh_host_memory_used_percent 60.00')
  })

  /**
   * A label value has to be escaped for the exposition format, where only `\\`, `"` and
   * `\n` are special. `diskPaths` is user config, and a Windows path is the reachable
   * case: `C:\Users\me` emitted `\U`, not a valid escape, so a scraper rejected the whole
   * sample. The ids are charset-constrained by their schemas; the paths are not.
   */
  it('escapes a disk path that carries a backslash', async () => {
    const created = await fixture()
    // The host view's disk paths come from the resolved config, so drive the route the
    // way a real Windows panel would report it.
    const view = created.panel.getState().host
    const patched = { ...view, sampledAt: 1, disks: [{ path: 'C:\\Users\\me', totalBytes: 100, freeBytes: 50, usedPercent: 50 }] }
    vi.spyOn(created.panel, 'getState').mockReturnValue({ ...created.panel.getState(), host: patched })

    const text = await (await created.app.request('/api/metrics')).text()
    const line = text.split('\n').find(entry => entry.startsWith('hh_host_disk_used_percent'))
    expect(line).toBeDefined()
    // Every backslash is doubled, so no bare `\U` survives.
    expect(line).toContain('mount="C:\\\\Users\\\\me"')
    expect(line).not.toContain('C:\\Users\\me')
  })
})

/** A plan body the route can answer with; the fields a caller reads, filled. */
function restorePlan(overrides: Partial<RestorePlan> = {}): RestorePlan {
  return {
    dryRun: true,
    encrypted: false,
    needsPassword: false,
    items: [],
    applied: [],
    skipped: [],
    restartRequired: false,
    reloaded: false,
    ...overrides,
  }
}

/**
 * Backups over the local channel: an operator — or a cron job — needs to take, list and restore an
 * archive without a browser session. These call the same `BackupService` the `/api/backups` routes
 * do, so the archive shape and the allowlist have one implementation.
 */
/**
 * The selection model is fetched, not framed.
 *
 * `getState()` builds on every tick and on every request, and it used to carry `entries` — a
 * `readFileSync` of the global *and every workspace's* `.secrets.json` — plus `files`, a `statSync`
 * per archive. That made the frame's cost scale with workspaces × archives on a path rebuilt ~13×/s
 * (measured: 396 secrets reads in 8 s). They are `GET /api/backups` now, which a dialog asks for
 * when it opens.
 *
 * Asserted on the response body rather than on a call count, because the count is what a future
 * refactor changes; the wire shape is what a person pays for.
 */
describe('the state frame carries no backup selection model', () => {
  it('omits `entries` and `files`, and still carries the policy', async () => {
    const created = await fixture()
    const state = await (await created.app.request('/api/state')).json() as {
      backups: Record<string, unknown>
    }

    expect(state.backups).not.toHaveProperty('entries')
    expect(state.backups).not.toHaveProperty('files')
    // The policy half stays: the settings page renders from the frame.
    expect(state.backups).toMatchObject({ enabled: expect.any(Boolean), keep: expect.any(Number) })
    expect(state.backups).toHaveProperty('includePaths')
  })

  it('serves both halves from the dedicated route', async () => {
    const created = await fixture()
    const selection = await (await created.app.request('/api/backups')).json() as {
      dir: string
      entries: unknown[]
      files: unknown[]
    }

    expect(selection.entries.length).toBeGreaterThan(0)
    expect(Array.isArray(selection.files)).toBe(true)
    expect(typeof selection.dir).toBe('string')
    // …and it is not the policy: a dialog does not read `enabled` from here.
    expect(selection).not.toHaveProperty('enabled')
  })
})

describe('/_hh/backups', () => {
  const token = { 'x-home-hosted-token': 'runtime-token' }

  it('refuses a missing token, like every other local route', async () => {
    const created = await fixture()
    expect((await created.app.request('/_hh/backups')).status).toBe(403)
  })

  it('refuses a caller that is not on this machine', async () => {
    const created = await fixture({ ip: '10.0.0.5' })
    const response = await created.app.request('/_hh/backups', { headers: token })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'NOT_LOOPBACK' })
  })

  /**
   * Without `confirm=true` the local channel answers a plan, while its spec promised `{ file, files }`
   * — a generated client read `file` off a plan and got nothing. The spec now declares both shapes,
   * and each real body validates against the schema it documents.
   */
  it('documents both answers of POST /_hh/backups: the default plan, and the confirmed archive', async () => {
    const created = await fixture()
    const plan = await created.app.request('/_hh/backups', { method: 'POST', headers: token })
    expect(plan.status).toBe(200)
    const planBody = await plan.json()
    expect(planBody).toMatchObject({ apply: false, entries: expect.any(Array), includePaths: expect.any(Array) })
    expect(backupLocalResponseSchema(planBody) instanceof type.errors).toBe(false)

    const made = await created.app.request('/_hh/backups?confirm=true', { method: 'POST', headers: token })
    expect(made.status).toBe(200)
    const madeBody = await made.json()
    expect(madeBody).toMatchObject({ file: expect.any(Object), files: expect.any(Array) })
    expect(backupLocalResponseSchema(madeBody) instanceof type.errors).toBe(false)

    const spec = await (await created.app.request('/openapi/spec.json')).json() as { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: { anyOf?: Array<{ properties?: Record<string, unknown> }> } }> }> }>> }
    const shapes = spec.paths['/_hh/backups']!.post!.responses['200']!.content!['application/json']!.schema.anyOf ?? []
    expect(shapes.map(shape => Object.keys(shape.properties ?? {}).sort())).toEqual(expect.arrayContaining([
      ['apply', 'entries', 'includePaths'],
      ['file', 'files', 'warnings'],
    ]))
  })

  it('lists the archives for a local caller', async () => {
    const created = await fixture()
    const response = await created.app.request('/_hh/backups', { headers: token })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ files: expect.any(Array) })
  })

  it('refuses a restore whose name is not a plain archive in the backup directory', async () => {
    const created = await fixture()
    // `resolve` is the allowlist: a path traversal never reaches the filesystem.
    const response = await created.app.request('/_hh/backups/restore?name=../../etc/passwd', { method: 'POST', headers: token })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'BACKUP_NOT_FOUND' })
  })

  /**
   * `from` is a path, and it replaces `name` rather than joining it.
   *
   * The CLI resolves the path against *its own* directory, so what arrives here is absolute; a
   * relative one would be resolved against the panel's cwd, which is a different directory and
   * therefore a different file than the one the person typed.
   */
  it('refuses a relative from, naming why', async () => {
    const created = await fixture()
    const response = await created.app.request('/_hh/backups/restore?from=some/archive.zip', { method: 'POST', headers: token })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'FROM_NOT_ABSOLUTE' })
  })

  it('refuses name and from together instead of choosing one', async () => {
    const created = await fixture()
    const response = await created.app.request(`/_hh/backups/restore?name=x.zip&from=${encodeURIComponent('/tmp/x.zip')}`, { method: 'POST', headers: token })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'NAME_AND_FROM' })
  })

  it('plans a restore from a path, through the same service a name goes through', async () => {
    const created = await fixture()
    const seen: string[] = []
    created.backups.restore = async (archive) => {
      seen.push(archive)
      return restorePlan({ dryRun: true })
    }

    const archive = path.join(created.dir, 'elsewhere', 'carried.zip')
    const response = await created.app.request(`/_hh/backups/restore?from=${encodeURIComponent(archive)}`, { method: 'POST', headers: token })
    expect(response.status).toBe(200)
    // The path itself, not a name resolved into the backups directory.
    expect(seen).toEqual([archive])
  })
})

/**
 * A restore that writes `global:secrets` replaces the password and token hashes of the panel doing
 * the restoring, so a token-only caller could hand the panel to itself.
 *
 * Measured end to end before this guard: an attacker archived `global:secrets` from a throwaway
 * home, uploaded it to the victim panel with nothing but the bearer token, and the victim's
 * `.control-secrets.json` came back byte-identical to the attacker's — the owner locked out, the
 * attacker holding the panel. It is the same end the `DELETE`-narrowing closed, reached through a
 * second door, which is why the bar is the same: a session, not a token.
 */
/** Writes a real archive into the fixture's backup directory, and answers its name. */
async function archiveName(created: Fixture): Promise<string> {
  const result = await created.backups.create({})
  if (!result.ok || result.file === undefined)
    throw new Error(`the fixture could not write an archive: ${result.error ?? 'no file'}`)
  return result.file.name
}

describe('/api/backups restore and the credential store', () => {
  it('refuses a token-only restore that would write global:secrets', async () => {
    const created = await fixture({ password: 'correct horse' })
    const token = generateApiToken()
    setApiToken(created, token)
    const reached: unknown[] = []
    created.backups.restore = async (_archive, options) => {
      reached.push(options)
      return restorePlan({ dryRun: false, applied: ['global:secrets'] })
    }
    const name = await archiveName(created)

    // The token does authenticate, so this cannot pass for the wrong reason.
    expect((await created.app.request('/api/state', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)

    const response = await created.app.request('/api/backups/restore?confirm=true', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name, include: ['global:secrets'] }),
    })
    expect(response.status).toBe(403)
    const body = await response.json() as { code: string, message: string }
    expect(body.code).toBe('SESSION_REQUIRED')
    // The message must name a path this person can actually take.
    expect(body.message).toContain('session')
    expect(body.message).toContain('home-hosted backup restore')
    // Nothing was applied: the service was never reached.
    expect(reached).toEqual([])
  })

  it('allows the same restore when the credentials are excluded, which is the documented move', async () => {
    const created = await fixture({ password: 'correct horse' })
    const token = generateApiToken()
    setApiToken(created, token)
    created.backups.restore = async () => restorePlan({ dryRun: false, applied: ['workspace:default'] })
    const name = await archiveName(created)

    const response = await created.app.request('/api/backups/restore?confirm=true', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name, exclude: ['global:secrets'] }),
    })
    // The whole point of `--exclude global:secrets`: a token may restore everything else.
    expect(response.status).toBe(200)
  })

  it('lets a signed-in browser restore the credentials', async () => {
    const created = await fixture({ password: 'correct horse' })
    const cookie = await signIn(created, 'correct horse')
    created.backups.restore = async () => restorePlan({ dryRun: false, applied: ['global:secrets'] })
    const name = await archiveName(created)

    const response = await created.app.request('/api/backups/restore?confirm=true', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name, include: ['global:secrets'] }),
    })
    expect(response.status).toBe(200)
  })

  /**
   * The alias that walked around the guard above.
   *
   * `addItem` selected the credential item through its id **or its alias** — `secrets` — while
   * `selectionWritesCredentials` tested only `global:secrets` and `global:secrets:<field>`. So a
   * token-only restore naming the alias selected `.control-secrets.json` for writing and skipped the
   * session bar entirely: the archive's password and token hashes replaced the victim's, and the
   * remedy the docs name (revoke the leaked token) needs the session that takeover removes.
   *
   * Every spelling of the item, and the leaves under it, must reach the same refusal — and the
   * neighbours the docs let a token restore must still be allowed, which is what keeps this a fix
   * rather than a lock-out.
   */
  it('refuses a token-only restore naming the credential item by any of its spellings', async () => {
    const created = await fixture({ password: 'correct horse' })
    const token = generateApiToken()
    setApiToken(created, token)
    const reached: unknown[] = []
    created.backups.restore = async (_archive, options) => {
      reached.push(options)
      return restorePlan({ dryRun: false, applied: ['global:secrets'] })
    }
    const name = await archiveName(created)

    for (const include of [['global:secrets'], ['secrets'], ['global:secrets:password']]) {
      const response = await created.app.request('/api/backups/restore?confirm=true', {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name, include }),
      })
      expect(response.status, include.join()).toBe(403)
      expect(await response.json(), include.join()).toMatchObject({ code: 'SESSION_REQUIRED' })
    }
    // And the service was never reached: a refusal after the write would be no refusal at all.
    expect(reached).toEqual([])
  })

  /** The other half of the guard: the neighbours are still restorable with only a token. */
  it('still lets a token restore everything except the credentials, by either spelling', async () => {
    const created = await fixture({ password: 'correct horse' })
    const token = generateApiToken()
    setApiToken(created, token)
    created.backups.restore = async () => restorePlan({ dryRun: false, applied: ['global:settings'] })
    const name = await archiveName(created)

    for (const body of [{ include: ['config'] }, { exclude: ['global:secrets'] }, { exclude: ['secrets'] }]) {
      const response = await created.app.request('/api/backups/restore?confirm=true', {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name, ...body }),
      })
      expect(response.status, JSON.stringify(body)).toBe(200)
    }
  })
})

describe('/_hh/shutdown', () => {
  it('refuses a missing or wrong token', async () => {
    const created = await fixture()

    expect((await created.app.request('/_hh/shutdown', { method: 'POST' })).status).toBe(403)
    const wrong = await created.app.request('/_hh/shutdown', {
      method: 'POST',
      headers: { 'x-home-hosted-token': 'guessed' },
    })
    expect(wrong.status).toBe(403)
    expect(await wrong.json()).toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('refuses a caller that is not on this machine, even with the right token', async () => {
    const created = await fixture({ ip: '10.0.0.5' })
    const response = await created.app.request('/_hh/shutdown', {
      method: 'POST',
      headers: { 'x-home-hosted-token': 'runtime-token' },
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'NOT_LOOPBACK' })
    expect(created.shutdownCalls()).toBe(0)
  })

  it('answers before it stops, then shuts down once the response is out', async () => {
    const created = await fixture()

    const response = await created.app.request('/_hh/shutdown', {
      method: 'POST',
      headers: { 'x-home-hosted-token': 'runtime-token' },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    // Deferred on purpose: the answer has to reach `down` before the process goes.
    expect(created.shutdownCalls()).toBe(0)

    await new Promise(resolve => setImmediate(() => setImmediate(resolve)))
    expect(created.shutdownCalls()).toBe(1)
  })

  /**
   * `?withPersistent=true` is `down --with-persistent`: a persistent entry survives a shutdown by
   * design, so only an explicit ask ends it. An absent query must keep the old behaviour, because
   * every panel that predates this flag calls the bare route.
   */
  it('carries withPersistent from the query, and defaults it off', async () => {
    const created = await fixture()

    await created.app.request('/_hh/shutdown', {
      method: 'POST',
      headers: { 'x-home-hosted-token': 'runtime-token' },
    })
    await new Promise(resolve => setImmediate(() => setImmediate(resolve)))

    await created.app.request('/_hh/shutdown?withPersistent=true', {
      method: 'POST',
      headers: { 'x-home-hosted-token': 'runtime-token' },
    })
    await new Promise(resolve => setImmediate(() => setImmediate(resolve)))

    expect(created.shutdownOptions()).toEqual([{ withPersistent: false }, { withPersistent: true }])
  })
})

/**
 * The panel's **Free port** button has always been an `/api` route; a CLI-only user had no way to
 * reach it, which is the one situation a headless operator hits. The local channel now carries it,
 * so `free-port` needs run.json's token and nothing else.
 */
describe('/_hh/servers/:id/free-port', () => {
  const local = { 'x-home-hosted-token': 'runtime-token' }

  it('frees the port over the local channel, no session needed', async () => {
    const created = await fixture({ views: [makeView('web')] })
    created.supervisor.freePort = async () => ({
      ok: true,
      port: 4010,
      terminated: [4242],
      forced: [],
      skipped: [],
      free: true,
    })

    const response = await created.app.request('/_hh/servers/web/free-port', { method: 'POST', headers: local })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, port: 4010, terminated: [4242], free: true })
  })

  it('answers the refusal with its sentence and a status that says which kind it was', async () => {
    const created = await fixture({ views: [makeView('web')] })
    // A held port this panel supervises: refused, never signalled.
    created.supervisor.freePort = async () => ({
      ok: false,
      port: 4010,
      terminated: [],
      forced: [],
      skipped: [99],
      free: false,
      error: 'port 4010 is held by pid 99, which this panel supervises — stop that server instead',
    })

    const response = await created.app.request('/_hh/servers/web/free-port', { method: 'POST', headers: local })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ ok: false, skipped: [99] })
  })

  it('refuses without the local token, like every other local route', async () => {
    const created = await fixture({ views: [makeView('web')] })
    const response = await created.app.request('/_hh/servers/web/free-port', { method: 'POST' })
    expect(response.status).toBe(403)
  })
})

describe('/_hh/servers/:id/start|stop|restart', () => {
  const local = { 'x-home-hosted-token': 'runtime-token' }

  it('drives one server with the run.json token, no session needed', async () => {
    const created = await fixture({ views: [makeView('web')] })
    const calls: string[] = []
    created.supervisor.start = async (id) => {
      calls.push(`start ${id}`)
      return { ok: true }
    }
    created.supervisor.stop = async (id) => {
      calls.push(`stop ${id}`)
      return { ok: true }
    }
    // `restart` is the UI's per-server button; the shell reaches it through this route.
    created.supervisor.restart = async (id) => {
      calls.push(`restart ${id}`)
      return { ok: true }
    }

    for (const action of ['start', 'stop', 'restart'] as const) {
      const response = await created.app.request(`/_hh/servers/web/${action}`, { method: 'POST', headers: local })
      expect(response.status, action).toBe(200)
      expect(await response.json(), action).toEqual({ ok: true })
    }
    expect(calls).toEqual(['start web', 'stop web', 'restart web'])
  })

  it('routes a per-server restart, and refuses it without a local token', async () => {
    const created = await fixture({ views: [makeView('web')] })
    // The workspace pair is what scopes it: two workspaces may both have a "web".
    created.supervisor.restart = async id => ({ ok: true, id })

    const allowed = await created.app.request('/_hh/servers/web/restart?workspace=default', { method: 'POST', headers: local })
    expect(allowed.status).toBe(200)

    const refused = await created.app.request('/_hh/servers/web/restart', { method: 'POST' })
    expect(refused.status).toBe(403)
  })

  it('refuses a missing token, and a caller that is not on this machine', async () => {
    const noToken = await fixture()
    expect((await noToken.app.request('/_hh/servers/web/start', { method: 'POST' })).status).toBe(403)

    const remote = await fixture({ ip: '10.0.0.5' })
    const response = await remote.app.request('/_hh/servers/web/start', { method: 'POST', headers: local })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'NOT_LOOPBACK' })
  })

  it('answers a refusal with the supervisor’s reason, 409 for that and 404 for an unknown id', async () => {
    const created = await fixture()
    created.supervisor.start = async () => ({ ok: false, error: 'server "web" is disabled' })
    created.supervisor.stop = async id => missingServer(id)

    const refused = await created.app.request('/_hh/servers/web/start', { method: 'POST', headers: local })
    expect(refused.status).toBe(409)
    /**
     * `message`/`code` beside `ok`/`error`, as every other failure carries them.
     *
     * The local channel used to answer the bare `{ ok, error }` here while `/api/servers/:id/start`
     * carried the full envelope, so the same refusal read two ways depending on the channel and a
     * client of the documented error shape had nothing to branch on. `ok`/`error` stay for older
     * readers; the additions are optional, so an older client is unaffected.
     */
    expect(await refused.json()).toEqual({ ok: false, error: 'server "web" is disabled', message: 'server "web" is disabled', code: 'ACTION_FAILED' })

    const missing = await created.app.request('/_hh/servers/nope/stop', { method: 'POST', headers: local })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ ok: false, error: 'unknown server "nope"', message: 'unknown server "nope"', code: 'UNKNOWN_SERVER' })
  })

  /**
   * The spec has to declare the statuses these routes actually answer.
   *
   * `start`/`stop`/`restart` answer 409 for any refusal that is not a missing id, but their
   * `describeRoute` listed only 200/403/404, so `finishSpec` never added a body for the 409 and a
   * client generated from `/openapi/spec.json` had no handler for it at all.
   */
  it('declares the 409 its lifecycle routes answer', async () => {
    const created = await fixture()
    const spec = await (await created.app.request('/openapi/spec.json')).json() as {
      paths: Record<string, Record<string, { responses: Record<string, { content?: unknown }> }>>
    }
    for (const route of ['/_hh/servers/{id}/start', '/_hh/servers/{id}/stop', '/_hh/servers/{id}/restart']) {
      const responses = spec.paths[route]?.post?.responses
      expect(responses, `${route} must be in the spec`).toBeDefined()
      expect(Object.keys(responses!), `${route} must declare its 409`).toContain('409')
      expect(responses!['409']!.content, `${route}'s 409 must carry the error envelope`).toBeDefined()
    }
  })
})

describe('static UI', () => {
  /**
   * Every miss on a JSON surface answers the `{ message, code }` envelope. A non-GET fell past the
   * GET-only catch-all to Hono's plain-text 404 (the shared client then threw a SyntaxError), and a
   * GET under `/_hh` or `/openapi` was answered with the SPA's `index.html` and a 200.
   */
  it('answers every unmatched API-side request with the JSON envelope', async () => {
    const created = await fixture()
    const misses: Array<[string, string]> = [
      ['POST', '/api/nope'],
      ['DELETE', '/api/servers'],
      ['GET', '/_hh/nope'],
      ['GET', '/openapi/nope'],
      ['PUT', '/somewhere'],
    ]
    for (const [method, url] of misses) {
      const response = await created.app.request(url, { method })
      expect(response.status, `${method} ${url}`).toBe(404)
      expect(await response.json(), `${method} ${url}`).toMatchObject({ code: 'NOT_FOUND', message: expect.any(String) })
    }
  })

  it('names a malformed JSON body as INVALID_INPUT', async () => {
    const created = await fixture()
    const response = await created.app.request('/api/servers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('serves index.html for / and for a client-side route', async () => {
    const created = await fixture()

    for (const url of ['/', '/servers/web']) {
      const response = await created.app.request(url)
      expect(response.status, url).toBe(200)
      expect(response.headers.get('content-type'), url).toContain('text/html')
      expect(await response.text(), url).toContain('<title>stock</title>')
    }
  })

  it('caches a hashed asset for a year and revalidates the entry document', async () => {
    const created = await fixture()
    const assets = path.join(created.ui.resolveDir(), 'assets')
    fs.mkdirSync(assets, { recursive: true })
    fs.writeFileSync(path.join(assets, 'app-1a2b.js'), 'console.log(1)')

    const asset = await created.app.request('/assets/app-1a2b.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')

    const index = await created.app.request('/')
    expect(index.headers.get('cache-control')).toBe('no-cache')
  })

  it('falls back to an octet-stream for an extension it does not know', async () => {
    const created = await fixture()
    fs.writeFileSync(path.join(created.ui.resolveDir(), 'thing.bin'), 'binary')

    const response = await created.app.request('/thing.bin')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('never serves a file outside the UI root, however the path is encoded', async () => {
    const created = await fixture()
    // A readable secret one level above the served directory.
    fs.writeFileSync(path.join(created.dir, 'secret.txt'), 'do-not-serve-me')

    // The control: a legitimate asset *is* served, so "the secret was not served" cannot be
    // satisfied by a route that answers 404 to everything — which is what this test asserted
    // before, and why it could pass while serving nothing at all.
    const index = await created.app.request('/')
    expect(index.status).toBe(200)
    expect(await index.text()).not.toBe('')

    for (const url of ['/%2e%2e/secret.txt', '/assets/%2e%2e%2f%2e%2e/secret.txt', '/..%2fsecret.txt']) {
      const response = await created.app.request(url)
      const body = await response.text()
      expect(body, url).not.toContain('do-not-serve-me')
      // A 200 here is the SPA fallback (the app answers an unknown route with `index.html`), not
      // the secret: the body is the UI's own index, which is what the length assertion pins so a
      // 200 cannot be mistaken for a served file.
      if (response.status === 200)
        expect(body, url).toBe(await (await created.app.request('/')).text())
    }
  })

  it('rejects a path it cannot decode instead of guessing', async () => {
    const created = await fixture()
    const response = await created.app.request('/%zz')

    expect(response.status).toBe(400)
    expect(await response.text()).toBe('bad path')
  })

  it('explains itself when no UI is installed at all', async () => {
    const created = await fixture()
    fs.rmSync(path.join(created.ui.resolveDir(), 'index.html'), { force: true })

    const response = await created.app.request('/')
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('no UI is installed')
  })
})

describe('openapi document', () => {
  it('names the credential each route really takes, and a body on every error', async () => {
    const created = await fixture()
    interface Operation { security?: unknown[], responses: Record<string, { content?: unknown }> }
    const spec = await (await created.app.request('/openapi/spec.json')).json() as { paths: Record<string, Record<string, Operation>> }

    expect(spec.paths['/healthz']!.get!.security).toEqual([])
    expect(spec.paths['/api/auth/login']!.post!.security).toEqual([])
    // Sign-out needs no credential, so an expired session can still clear its cookie.
    expect(spec.paths['/api/auth/logout']!.post!.security).toEqual([])
    expect(spec.paths['/_hh/shutdown']!.post!.security).toEqual([{ localToken: [] }])
    expect(Object.keys(spec.paths).some(route => route.startsWith('/_acme')), 'internal plumbing is not API').toBe(false)

    const start = spec.paths['/api/servers/{id}/start']!.post!
    expect(start.responses['409']!.content).toBeDefined()
    expect(start.responses['401']).toBeDefined()
    for (const [route, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          if (Number(status) >= 400)
            expect(response.content, `${method} ${route} ${status}`).toBeDefined()
        }
      }
    }
  })

  /**
   * Responses never reject an undeclared key — a newer panel adds fields, and a client generated from
   * this document must not refuse them. `POST`/`PUT`/`PATCH /api/servers` answered with the strict
   * write schema and published `additionalProperties: false` at every depth of the entry.
   */
  it('never publishes `additionalProperties: false` in a response', async () => {
    const created = await fixture()
    const spec = await (await created.app.request('/openapi/spec.json')).json() as { paths: Record<string, Record<string, { responses?: unknown }>> }
    const strict: string[] = []
    const walk = (node: unknown, where: string): void => {
      if (node === null || typeof node !== 'object')
        return
      if ((node as { additionalProperties?: unknown }).additionalProperties === false)
        strict.push(where)
      for (const [key, value] of Object.entries(node)) walk(value, `${where}/${key}`)
    }
    for (const [route, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) walk(operation.responses, `${method.toUpperCase()} ${route}`)
    }
    expect(strict).toEqual([])
  })

  it('is generated from the live route table', async () => {
    const created = await fixture()
    const response = await created.app.request('/openapi/spec.json')

    expect(response.status).toBe(200)
    const spec = await response.json() as { openapi: string, paths: Record<string, unknown> }
    expect(spec.openapi).toMatch(/^3\./)
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining([
      '/api/state',
      '/api/servers',
      '/api/servers/{id}',
      '/api/settings',
      '/api/ddns',
      '/api/logs',
      '/api/backups',
      '/healthz',
    ]))
  })

  /**
   * A generated client cannot authenticate from a spec that never mentions auth.
   *
   * Every `/api` route takes `Authorization: Bearer hh_…`, and the document declared no
   * `securitySchemes` at all — so openapi-typescript, openapi-generator and Scalar's "try it"
   * all produced clients with no auth hook, while the README tells an agent this document *is*
   * the API it may call. The workaround was to read the prose and hand-write a client.
   */
  /**
   * The browsable reference must not be an empty page on a box with no internet.
   *
   * `/openapi/ui` used to be `Scalar()` alone, whose whole body is a module script importing from
   * `cdn.jsdelivr.net`. Measured in Chromium with every non-panel request aborted, `#app` had **0
   * children and 0 characters**: the page a person opens to read the API was blank on the LAN the
   * docs describe, and `docs/UI_CREATION.md` point 5 says an offline home server should not need a
   * CDN. The page now renders the route index from `spec.json` itself and treats the CDN browser as
   * optional enhancement.
   *
   * Scalar itself is not the constraint — its standalone bundle renders offline when self-hosted, at
   * 4.9 MB. Rendering the index here is the cheaper trade, not the only one available.
   *
   * Asserted on the document, because whether a CDN is reachable is not something a unit test can
   * decide: the fallback markup has to be *in the HTML the server sends*, before any script runs.
   */
  it('serves an API reference that works with no CDN', async () => {
    const created = await fixture()
    const response = await created.app.request('/openapi/ui')

    expect(response.status).toBe(200)
    const html = await response.text()
    // The index is built client-side from the spec, so the spec URL must be in the served document.
    expect(html).toContain('/openapi/spec.json')
    // It renders something before any network call, and it names the route index as its own content.
    expect(html).toContain('id="app"')
    expect(html).toContain('Loading the route index')
    // Enhancement is allowed to fail; the import must be the only CDN reference and it must be caught.
    expect(html).toMatch(/try\s*\{[\s\S]*cdn\.jsdelivr\.net[\s\S]*catch/)
    // …and it must name a version. A floating `@scalar/api-reference` lets an upstream release change
    // or break the panel's own page with no commit here; the pinned form is `@scalar/api-reference@1.2.3`.
    expect(html).toMatch(/@scalar\/api-reference@\d+\.\d+\.\d+/)
  })

  it('declares the auth scheme a generated client needs', async () => {
    const created = await fixture()
    const spec = await (await created.app.request('/openapi/spec.json')).json() as {
      components?: { securitySchemes?: Record<string, { type?: string, scheme?: string }> }
      security?: Array<Record<string, unknown>>
    }

    const scheme = spec.components?.securitySchemes?.bearerAuth
    expect(scheme, 'a client generator needs a securitySchemes entry').toBeDefined()
    expect(scheme).toMatchObject({ type: 'http', scheme: 'bearer' })
    // Declared globally, so every operation inherits it without repeating the block.
    expect(spec.security).toEqual([{ bearerAuth: [] }])
  })

  /**
   * The `400` the document declares is the `400` this server actually sends.
   *
   * hono-openapi injects its own default on any operation with a validator that does not name a
   * `400`: `{ success: false, error: [], data }`. This API has never sent that shape — every failure
   * is one `DetailedError` envelope, `{ message, code, detail }` (`src/helpers/error.ts`), which is
   * what AGENTS.md promises and what a client parses. Measured before the fix on **29 operations**
   * (`GET /api/servers`, every `/_hh` lifecycle route, `GET /api/logs/{id}`, …); the wire body was
   * always right, so this was a documentation defect that every generated client inherited.
   *
   * Walked over every operation rather than sampled, because the default is applied per operation
   * and a route added tomorrow must not reintroduce it.
   */
  it('declares this API’s own error envelope for every 400, not the library default', async () => {
    const created = await fixture()
    const spec = await (await created.app.request('/openapi/spec.json')).json() as {
      paths: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown>, required?: string[] } }> }> } | undefined>>
    }

    const wrong: string[] = []
    let checked = 0
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const schema = operation?.responses?.['400']?.content?.['application/json']?.schema
        if (schema === undefined)
          continue
        checked += 1
        const keys = Object.keys(schema.properties ?? {})
        // The library default is recognizable by `success`/`data`; this API's envelope by
        // `message`/`code`. Either names the right shape or it is the wrong one.
        if (!keys.includes('message') || !keys.includes('code') || keys.includes('success'))
          wrong.push(`${method.toUpperCase()} ${path}: ${keys.join(',')}`)
      }
    }

    expect(checked, 'the document must declare 400s for this to guard anything').toBeGreaterThan(10)
    expect(wrong, 'these operations document an envelope the server never sends').toEqual([])
  })

  /**
   * Every tag an operation uses has to be declared, or a docs renderer dumps it in an
   * uncategorised bucket. Three (`ddns`, `proxy`, `workspaces`) were used but never listed.
   */
  it('declares every tag its operations use', async () => {
    const created = await fixture()
    const spec = await (await created.app.request('/openapi/spec.json')).json() as {
      tags?: Array<{ name: string }>
      paths: Record<string, Record<string, { tags?: string[] } | undefined>>
    }

    const declared = new Set((spec.tags ?? []).map(tag => tag.name))
    expect(declared.size).toBeGreaterThan(5)

    const used = new Set<string>()
    for (const operations of Object.values(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (method === 'parameters' || operation === undefined)
          continue
        for (const tag of operation.tags ?? []) used.add(tag)
      }
    }
    expect([...used].filter(tag => !declared.has(tag))).toEqual([])
  })

  /**
   * A documented success with no schema is a body a client cannot bind to. The lifecycle
   * routes were the worst case: their failure shape was non-standard *and* their success was
   * declared as an untyped "Result", so there was nothing to generate either direction from.
   */
  it('gives every documented 2xx a schema', async () => {
    const created = await fixture()
    const spec = await (await created.app.request('/openapi/spec.json')).json() as {
      paths: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> } | undefined>>
    }

    /**
     * Routes that answer something other than a JSON body, so a JSON schema is the wrong thing
     * to ask of them. Listed rather than skipped by content-type: the point of the guard is that
     * adding an untyped JSON route fails it, which needs the exception to be explicit.
     */
    const NOT_JSON = new Set([
      'GET /api/events', // SSE stream
      'GET /api/servers/{id}/stream', // SSE stream
      'GET /api/metrics', // Prometheus text
      'GET /api/logs/{id}/download', // a log file
      'GET /api/backups/{name}/download', // a zip
      'POST /_acme/{action}', // the engine's challenge channel
      'POST /api/settings/tls', // moves the listener; answers the new TLS status with no body contract
    ])

    const untyped: string[] = []
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (method === 'parameters' || operation?.responses === undefined)
          continue
        for (const [status, response] of Object.entries(operation.responses)) {
          if (!status.startsWith('2'))
            continue
          if (NOT_JSON.has(`${method.toUpperCase()} ${path}`))
            continue
          const schema = response.content?.['application/json']?.schema
          if (schema === undefined)
            untyped.push(`${method.toUpperCase()} ${path} → ${status}`)
        }
      }
    }
    expect(untyped).toEqual([])
  })

  /**
   * The other half of that promise: a route that *reads* a body must declare one.
   *
   * A generated client sends no body when the document declares none, so a POST that needs a `name`
   * is uncallable — `POST /api/backups/restore` was the only `/api` write route that parsed a JSON
   * body and declared nothing, and it is the one that takes `{ name }`. A caller following the
   * README's "this document is the API" got a 400 `MISSING_ARCHIVE` from a client the document
   * told it to generate.
   *
   * The route list is derived from the source rather than hand-kept: every `validate('json', …)`
   * and every `c.req.json()` belongs to an operation that owes a `requestBody`.
   */
  it('declares a requestBody for every route that reads one', async () => {
    const created = await fixture()
    const spec = await (await created.app.request('/openapi/spec.json')).json() as {
      paths: Record<string, Record<string, { requestBody?: unknown } | undefined>>
    }

    // `parseOrThrow(<schema>, await c.req.json()…)` is the one body read that bypasses `validate`,
    // so it is named rather than discovered: a grep cannot follow the schema into the handler.
    const READS_JSON: Array<[method: string, path: string]> = [
      ['post', '/api/backups/restore'],
    ]
    const declared = READS_JSON.filter(([method, path]) => spec.paths[path]?.[method]?.requestBody === undefined)
    expect(declared, 'a route that parses a JSON body must declare it').toEqual([])
  })

  /**
   * A schema that describes a body the route never sends is worse than none: a generated client
   * binds to fields that are always `undefined`, with no error anywhere.
   *
   * The guard above only checks a schema *exists*, so it passed while two of them were wrong —
   * `POST /api/backups` declared an `ok` the handler never sends, and `DELETE /api/settings/tls`
   * declared the plain `{ok}` envelope while returning the TLS review. This one compares the
   * declared property names against a real response body, so the description has to be true.
   */
  it('declares the fields its handlers actually send', async () => {
    const created = await fixture()
    const spec = await (await created.app.request('/openapi/spec.json')).json() as {
      paths: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }> } | undefined>>
    }

    /** Declared property names for one route's success body. */
    const declaredKeys = (path: string, method: string, status = '200'): string[] => {
      const schema = spec.paths[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema
      return Object.keys(schema?.properties ?? {}).sort()
    }

    // `POST /api/backups` — the handler sends `{ file, files }`, plus `warnings` only when it has one.
    const backup = await form(created.app, '/api/backups', 'POST', {})
    expect(backup.status).toBe(200)
    const backupBody = await backup.json() as Record<string, unknown>
    expect(declaredKeys('/api/backups', 'post')).toEqual([...new Set([...Object.keys(backupBody), 'warnings'])].sort())

    // `DELETE /api/settings/tls` — the handler sends the review, not `{ ok }`.
    const tls = await created.app.request('/api/settings/tls', { method: 'DELETE' })
    expect(tls.status).toBe(200)
    const tlsBody = await tls.json() as Record<string, unknown>
    expect(declaredKeys('/api/settings/tls', 'delete')).toEqual(Object.keys(tlsBody).sort())
  })

  /**
   * Every *required* field a schema declares must actually be sent.
   *
   * The check above pins two routes by hand, which is why two more drifted: `DELETE
   * /api/settings/ui` sent `removed` its schema never declared, and `GET /api/logs/{id}` declared
   * only `lines` while sending six fields. A hand-kept list is the thing `AGENTS.md` warns about —
   * this walks the whole document instead, so a route added tomorrow is covered without anyone
   * remembering.
   *
   * Only *required* properties are checked: an optional field may legitimately be absent, and a
   * response schema must not reject a newer panel's extra key.
   */
  it('declares the fields its handlers send, not only on the two routes above', async () => {
    const created = await fixture()

    /** Declared property names for one route's success body. */
    const declaredKeys = async (path: string, method: string, status = '200'): Promise<string[]> => {
      const spec = await (await created.app.request('/openapi/spec.json')).json() as {
        paths: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }> } | undefined>>
      }
      const schema = spec.paths[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema
      return Object.keys(schema?.properties ?? {}).sort()
    }

    // The two that drifted, each asserted against a real body. `declaredKeys` reads the live
    // document rather than a hand-kept list, which is what let the first two drift.
    //
    // The logs half used to sit inside `if (logs.status === 200)` with a request for a server the
    // fixture never creates — always 404, so the assertion never ran and undeclaring every log
    // field left the suite green. The entry is declared here, and the status is asserted.
    const withServer = await fixture({
      servers: [{ id: 'web', command: 'node' }],
      views: [makeView('web', { config: { id: 'web', command: 'node' } as never })],
    })
    const logs = await withServer.app.request('/api/logs/web')
    expect(logs.status, 'the fixture must reach the route, or this guard checks nothing').toBe(200)
    const logsBody = await logs.json() as Record<string, unknown>
    expect(await declaredKeys('/api/logs/{id}', 'get'), 'GET /api/logs/{id}').toEqual(Object.keys(logsBody).sort())

    /**
     * The **buffered** log route is the other half, and it was the one still wrong.
     *
     * `GET /api/servers/{id}/logs` answers `{ lines }` — no window, no rotation, no search — but it
     * declared `logLinesResponseSchema`, a copy of the disk shape. So the document promised five
     * fields the handler never sent, and declared `searched` as an array where the disk route sends
     * a number. This guard only walked `/api/logs/{id}`, so the sibling was never checked.
     */
    const buffered = await withServer.app.request('/api/servers/web/logs')
    expect(buffered.status, 'the fixture must reach the route, or this guard checks nothing').toBe(200)
    const bufferedBody = await buffered.json() as Record<string, unknown>
    expect(await declaredKeys('/api/servers/{id}/logs', 'get'), 'GET /api/servers/{id}/logs')
      .toEqual(Object.keys(bufferedBody).sort())

    const ui = await created.app.request('/api/settings/ui', { method: 'DELETE' })
    expect(ui.status, 'the fixture must reach the route, or this guard checks nothing').toBe(200)
    const uiBody = await ui.json() as Record<string, unknown>
    const declared = await declaredKeys('/api/settings/ui', 'delete')
    for (const key of Object.keys(uiBody))
      expect(declared, `DELETE /api/settings/ui sends ${key} but does not declare it`).toContain(key)
  })

  /**
   * The document is a promise to clients, so the shape it declares has to be the shape
   * the route actually answers. A write returns the *stored* entry — flat, no `config`
   * wrapper and no live status — while a read returns a view; declaring the view for both
   * silently misled a consumer reading `server.config` off a create, which got `undefined`
   * with no error anywhere.
   */
  it('declares the flat stored entry for a write, and the view for a read', async () => {
    const created = await fixture()
    const spec = await (await created.app.request('/openapi/spec.json')).json() as {
      paths: Record<string, { post?: { responses: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, { properties?: Record<string, unknown>, required?: string[] }> } }> }> } }>
    }

    // What the document says the `server` field is.
    const schema = spec.paths['/api/servers']!.post!.responses['201']!.content!['application/json']!.schema!
    const declared = schema.properties!.server!
    const declaredKeys = Object.keys(declared.properties ?? {})

    // A view declares `config` (the entry nested inside it); the stored entry does not.
    const response = await form(created.app, '/api/servers', 'POST', { id: 'web', command: 'node', args: ['x.js'] })
    expect(response.status).toBe(201)
    const { server } = await response.json() as { server: Record<string, unknown> }

    // The document and the body must agree on which of the two shapes this is.
    expect(declaredKeys.includes('config')).toBe(server.config !== undefined)
    // …and the body is the flat stored entry, which the write really returns.
    expect(server).not.toHaveProperty('config')
    expect(server).toHaveProperty('command', 'node')
    expect(serverSchema(server) instanceof type.errors, JSON.stringify(serverSchema(server))).toBe(false)
  })
})

/** Reads SSE frames until `done` says stop, or the deadline passes. */
async function readFrames(reader: ReadableStreamDefaultReader<Uint8Array>, decoder: InstanceType<typeof TextDecoder>, text: string, done: (all: string) => boolean, timeoutMs = 1500): Promise<string> {
  let all = text
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !done(all)) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>(resolve => setTimeout(resolve, Math.max(1, deadline - Date.now()), null)),
    ])
    if (chunk === null || chunk.done)
      break
    all += decoder.decode(chunk.value, { stream: true })
  }
  return all
}

describe('panel event stream', () => {
  it('opens with the full state snapshot', async () => {
    const created = await fixture({ views: [makeView('web')] })
    const response = await created.app.request('/api/events')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const first = await readFrames(reader, decoder, '', text => text.includes('event: hello'), 2000)
    await reader.cancel().catch(() => {})

    expect(first).toContain('event: hello')
    expect(first).toContain('"web"')
  })

  it('drops log frames for a client that asked for state only', async () => {
    const created = await fixture({ views: [makeView('web')] })
    const response = await created.app.request('/api/events?logs=0')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    // The hello frame proves the subscription is live before anything is published.
    const hello = await readFrames(reader, decoder, '', text => text.includes('event: hello'), 2000)
    expect(hello).toContain('event: hello')

    created.hub.publish({ type: 'log', ts: Date.now(), serverId: 'web', lines: [{ ts: 1, stream: 'stdout', text: 'too chatty' }] })
    created.hub.publish({ type: 'server', ts: Date.now(), serverId: 'web', server: makeView('web') })

    const rest = await readFrames(reader, decoder, hello, text => text.includes('event: server'))
    await reader.cancel().catch(() => {})

    // The state frame arrives, the log frame never does.
    expect(rest).toContain('event: server')
    expect(rest).not.toContain('event: log')
    expect(rest).not.toContain('too chatty')
  })

  it('narrows server and log frames to the workspace a client named', async () => {
    const created = await fixture({ views: [makeView('web')] })
    const response = await created.app.request(`/api/events?workspace=${created.defaultId}`)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    const hello = await readFrames(reader, decoder, '', text => text.includes('event: hello'), 2000)
    created.hub.publish({ type: 'log', ts: Date.now(), workspaceId: 'elsewhere', serverId: 'web', lines: [{ ts: 1, stream: 'stdout', text: 'not mine' }] })
    created.hub.publish({ type: 'log', ts: Date.now(), workspaceId: created.defaultId, serverId: 'web', lines: [{ ts: 1, stream: 'stdout', text: 'mine' }] })

    const rest = await readFrames(reader, decoder, hello, text => text.includes('"mine"'))
    await reader.cancel().catch(() => {})
    expect(rest).toContain('"mine"')
    expect(rest).not.toContain('not mine')
  })

  /** Reads until the server ends the stream; true when it did within the deadline. */
  async function streamEnds(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 1500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>(resolve => setTimeout(resolve, Math.max(1, deadline - Date.now()), null)),
      ])
      if (chunk === null)
        return false
      if (chunk.done)
        return true
    }
    return false
  }

  /**
   * The guard only sees the request that opens a stream. Without a re-check, a stream opened before a
   * sign-out or a password change kept delivering every frame and log line for as long as it stayed
   * connected.
   */
  it.each(['/api/events', '/api/servers/web/stream'])('ends %s when its session signs out', async (url) => {
    const created = await fixture({ password: 'correct horse', servers: [{ id: 'web', command: 'node' }], views: [makeView('web')] })
    const cookie = await signIn(created, 'correct horse')
    const response = await created.app.request(url, { headers: { cookie } })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    await readFrames(reader, new TextDecoder(), '', text => text.includes('event: '), 2000)

    const logout = await created.app.request('/api/auth/logout', { method: 'POST', headers: { cookie } })
    expect(logout.status).toBe(200)
    expect(await streamEnds(reader)).toBe(true)
  })

  it('ends a stream when the password changes, but not the one that changed it', async () => {
    const created = await fixture({ password: 'correct horse' })
    const other = await signIn(created, 'correct horse')
    const mine = await signIn(created, 'correct horse')
    const otherStream = (await created.app.request('/api/events', { headers: { cookie: other } })).body!.getReader()
    const myStream = (await created.app.request('/api/events', { headers: { cookie: mine } })).body!.getReader()
    await readFrames(otherStream, new TextDecoder(), '', text => text.includes('event: hello'), 2000)
    await readFrames(myStream, new TextDecoder(), '', text => text.includes('event: hello'), 2000)

    const changed = await created.app.request('/api/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cookie': mine },
      body: JSON.stringify({ currentPassword: 'correct horse', newPassword: 'battery staple' }),
    })
    expect(changed.status).toBe(200)
    expect(await streamEnds(otherStream)).toBe(true)
    expect(await streamEnds(myStream, 300)).toBe(false)
    await myStream.cancel().catch(() => {})
  })

  /** A change the panel is not told about — the CLI rewriting the password file — is caught on the next ping. */
  it('ends a stream on the next ping once its credential stopped being valid', async () => {
    const created = await fixture({ password: 'correct horse' })
    const cookie = await signIn(created, 'correct horse')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let reader: ReadableStreamDefaultReader<Uint8Array>
    try {
      reader = (await created.app.request('/api/events', { headers: { cookie } })).body!.getReader()
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain('event: hello')

      // `set-password` in another process: same file, no notification to this one.
      vi.advanceTimersByTime(5)
      new SecretsStore(path.join(created.dir, '.hh', '.control-secrets.json'), undefined, 'global').setPassword('rotated elsewhere')
      await vi.advanceTimersByTimeAsync(15_000)
    }
    finally {
      vi.useRealTimers()
    }
    expect(await streamEnds(reader)).toBe(true)
  })

  it('does not keep an idle session alive by re-checking it', async () => {
    const created = await fixture({ password: 'correct horse' })
    const cookie = await signIn(created, 'correct horse')
    const token = cookie.split('=')[1]!
    const before = created.auth.validate(token, { slide: false })!.expiresAt
    const reader = (await created.app.request('/api/events', { headers: { cookie } })).body!.getReader()
    await readFrames(reader, new TextDecoder(), '', text => text.includes('event: hello'), 2000)
    const opened = created.auth.validate(token, { slide: false })!.expiresAt

    created.auth.notifyCredentialsChanged()
    expect(created.auth.validate(token, { slide: false })!.expiresAt).toBe(opened)
    expect(opened).toBeGreaterThanOrEqual(before)
    await reader.cancel().catch(() => {})
  })

  /** Server ids repeat across workspaces: a bare `serverId` means the default workspace's server, never both. */
  it('scopes ?serverId= without ?workspace= to the default workspace', async () => {
    const created = await fixture({ workspaces: [{ id: 'staging' }], views: [makeView('web')] })
    const reader = (await created.app.request('/api/events?serverId=web')).body!.getReader()
    const decoder = new TextDecoder()
    const hello = await readFrames(reader, decoder, '', text => text.includes('event: hello'), 2000)

    created.hub.publish({ type: 'log', ts: Date.now(), workspaceId: 'staging', serverId: 'web', lines: [{ ts: 1, stream: 'stdout', text: 'staging line' }] })
    created.hub.publish({ type: 'log', ts: Date.now(), workspaceId: created.defaultId, serverId: 'web', lines: [{ ts: 1, stream: 'stdout', text: 'default line' }] })
    const rest = await readFrames(reader, decoder, hello, text => text.includes('default line'))
    await reader.cancel().catch(() => {})
    expect(rest).toContain('default line')
    expect(rest).not.toContain('staging line')

    expect((await created.app.request('/api/events?serverId=web&workspace=nope')).status).toBe(404)
  })

  it('forwards log frames by default', async () => {
    const created = await fixture({ views: [makeView('web')] })
    const response = await created.app.request('/api/events')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    const hello = await readFrames(reader, decoder, '', text => text.includes('event: hello'), 2000)
    created.hub.publish({ type: 'log', ts: Date.now(), serverId: 'web', lines: [{ ts: 1, stream: 'stdout', text: 'live line' }] })

    const rest = await readFrames(reader, decoder, hello, text => text.includes('event: log'))
    await reader.cancel().catch(() => {})

    expect(rest).toContain('event: log')
    expect(rest).toContain('live line')
  })
})

describe('auth: cookies and first-time setup', () => {
  it('honours an explicit cookie policy instead of the request protocol', async () => {
    const created = await fixture({ password: 'correct horse' })

    created.settings.updateControl({ auth: { cookieSecure: 'always' } })
    const always = await form(created.app, '/api/auth/login', 'POST', { password: 'correct horse' })
    expect(always.headers.get('set-cookie')).toMatch(/;\s*Secure/i)

    created.settings.updateControl({ auth: { cookieSecure: 'never' } })
    const never = await form(created.app, '/api/auth/login', 'POST', { password: 'correct horse' })
    expect(never.headers.get('set-cookie')).not.toMatch(/;\s*Secure/i)
  })

  /**
   * The session is an **idle** timeout — `validate()` slides `expiresAt` on every request — and the
   * login page says so ("each request extends that window"). The cookie did not: `Max-Age` was the
   * configured lifetime stamped once at login, so the browser deleted it a week after signing in
   * however busy the panel had been, and the person was signed out mid-use while the server still
   * held a perfectly good session. Measured against a real panel with `sessionTtlMs: 60000`: a
   * request every 10 s answered 200 through t=+60 s and 401 at t=+70 s.
   *
   * The guard therefore re-issues the cookie whenever the deadline it would hand out has moved by
   * more than a minute, which keeps the browser's copy in step without a `Set-Cookie` on every
   * request (an SSE stream opens one and holds it).
   */
  it('re-issues the session cookie as the sliding deadline moves, so a busy panel stays signed in', async () => {
    vi.useFakeTimers()
    try {
      const created = await fixture({ password: 'correct horse' })
      created.settings.updateControl({ auth: { sessionTtlMs: 120_000 } })

      const cookie = await signIn(created, 'correct horse')

      // A request a third of the lifetime later: the deadline slid, so the browser must be told.
      vi.advanceTimersByTime(40_000)
      const refreshed = await created.app.request('/api/state', { headers: { cookie } })
      expect(refreshed.status).toBe(200)
      const setCookie = refreshed.headers.get('set-cookie')
      expect(setCookie, 'a used session must tell the browser its new deadline').not.toBeNull()
      expect(setCookie!).toContain('hh_session=')
      // The full 120 s of idle allowance again, not the 80 s left on the original cookie.
      expect(setCookie!).toMatch(/Max-Age=11\d|Max-Age=120/)

      // Moments later it must NOT be re-sent: one `Set-Cookie` per request is noise.
      vi.advanceTimersByTime(5_000)
      const quiet = await created.app.request('/api/state', { headers: { cookie } })
      expect(quiet.status).toBe(200)
      expect(quiet.headers.get('set-cookie')).toBeNull()
    }
    finally {
      vi.useRealTimers()
    }
  })

  /**
   * The guard now sets this cookie too, so the one thing that must never happen is it re-arming a
   * cookie that logout just cleared — that would make signing out silently fail.
   */
  it('does not re-issue the cookie on the logout that clears it', async () => {
    vi.useFakeTimers()
    try {
      const created = await fixture({ password: 'correct horse' })
      created.settings.updateControl({ auth: { sessionTtlMs: 120_000 } })
      const cookie = await signIn(created, 'correct horse')

      // Far enough that the guard would refresh on any *other* route.
      vi.advanceTimersByTime(60_000)
      const response = await created.app.request('/api/auth/logout', { method: 'POST', headers: { cookie } })

      expect(response.status).toBe(200)
      const setCookie = response.headers.get('set-cookie')
      expect(setCookie).toContain('hh_session=')
      // Exactly one cookie, and it is the clearing one.
      expect(setCookie!.toLowerCase()).toContain('max-age=0')
      expect(setCookie).not.toMatch(/Max-Age=[1-9]/)

      // And the credential really is gone.
      expect((await created.app.request('/api/state', { headers: { cookie } })).status).toBe(401)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('arms authentication when the first password is set on this machine', async () => {
    const created = await fixture()
    expect(created.auth.isArmed()).toBe(false)

    const response = await form(created.app, '/api/auth/password', 'POST', { newPassword: 'first password' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, enabled: true })
    expect(created.auth.isArmed()).toBe(true)
    // From now on the guard means business.
    expect((await created.app.request('/api/state')).status).toBe(401)
  })

  it('clears the password when the panel is bound to loopback', async () => {
    const created = await fixture({ password: 'correct horse' })
    const cookie = await signIn(created, 'correct horse')

    const response = await created.app.request('/api/auth/password', { method: 'DELETE', headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(created.auth.passwordSet).toBe(false)
  })

  /**
   * The measured escalation: `POST` demands `currentPassword` so a stolen token cannot rewrite the
   * password, and `DELETE` demanded nothing but the token — so a token holder went
   * `POST` (400 `CURRENT_PASSWORD_REQUIRED`) → `DELETE` (200, auth off) → `POST` (200, no password
   * to prove) and left the panel armed with their own password.
   *
   * `DELETE` now demands a **session**. Both credentials resolve through the same
   * `requestIdentity()`, so this is the guard's own notion of "a browser", not a second one.
   */
  it('refuses a token-only DELETE, and names the ways a person can still clear it', async () => {
    const created = await fixture({ password: 'correct horse' })
    const token = generateApiToken()
    setApiToken(created, token)

    // The token does authenticate — otherwise this would pass for the wrong reason.
    expect((await created.app.request('/api/state', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)

    const response = await created.app.request('/api/auth/password', { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
    expect(response.status).toBe(403)
    const body = await response.json() as { code: string, message: string }
    expect(body.code).toBe('SESSION_REQUIRED')
    // The message has to name the real path: sign in, or the CLI on this machine.
    expect(body.message).toContain('session')
    expect(body.message).toContain('home-hosted set-password')
    // And nothing changed: the password and the auth switch are exactly as they were.
    expect(created.auth.passwordSet).toBe(true)
    expect(created.settings.control.auth.enabled).toBe(true)
  })

  it('still lets a signed-in browser clear the password, even with a token also set', async () => {
    const created = await fixture({ password: 'correct horse' })
    setApiToken(created, generateApiToken())
    const cookie = await signIn(created, 'correct horse')

    const response = await created.app.request('/api/auth/password', { method: 'DELETE', headers: { cookie } })
    expect(response.status).toBe(200)
    expect(created.auth.passwordSet).toBe(false)
  })

  /**
   * The loopback first-setup exemption is the documented escape hatch — "no password yet, set one
   * from this machine" — and a `DELETE` that only ever happens with a password set never touches it.
   * Pinned so a future stricter check cannot quietly lock someone out of their own host.
   */
  it('keeps the loopback first-setup exemption for POST with no password set', async () => {
    const created = await fixture()
    const response = await form(created.app, '/api/auth/password', 'POST', { newPassword: 'first password' })
    expect(response.status).toBe(200)
    expect(created.auth.passwordSet).toBe(true)
  })

  /** A remote token holder arming the panel with their own password would lock its owner out. */
  it('refuses a remote token setting the first password', async () => {
    const created = await fixture({ ip: '10.0.0.5' })
    const token = generateApiToken()
    setApiToken(created, token)

    const response = await created.app.request('/api/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
      body: JSON.stringify({ newPassword: 'attacker password' }),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'SESSION_REQUIRED' })
    expect(created.auth.passwordSet).toBe(false)
  })

  it('keeps both exposure guards on the session path too', async () => {
    // The guard is unchanged: a session that would otherwise be allowed still cannot clear a
    // password while the panel is exposed. (A token caller never reaches these — refused first.)
    const exposed = await fixture({ password: 'correct horse' })
    exposed.settings.updateControl({ host: 'lan', auth: { enabled: false } })
    const cookie = await signIn(exposed, 'correct horse')
    const bound = await exposed.app.request('/api/auth/password', { method: 'DELETE', headers: { cookie } })
    expect(bound.status).toBe(400)
    expect(await bound.json()).toMatchObject({ code: 'EXPOSED_WITHOUT_PASSWORD' })

    const proxied = await fixture({ password: 'correct horse' })
    proxied.settings.updateProxy({ enabled: true, routes: [{ id: 'panel', host: 'panel.lan', target: 'panel', tls: 'auto' }] })
    const proxiedCookie = await signIn(proxied, 'correct horse')
    const routed = await proxied.app.request('/api/auth/password', { method: 'DELETE', headers: { cookie: proxiedCookie } })
    expect(routed.status).toBe(400)
    expect(await routed.json()).toMatchObject({ code: 'PROXY_EXPOSURE_BLOCKED' })
  })
})

describe('workspace scoping', () => {
  it('resolves ?workspace= to that workspace, and 404s one that does not exist', async () => {
    const created = await fixture({
      views: [makeView('web')],
      workspaces: [{ id: 'staging' }],
      workspaceViews: { staging: [makeView('api')] },
    })

    const state = await (await created.app.request('/api/state')).json() as AppState
    expect(state.workspaces.map(workspace => workspace.id)).toEqual(['default', 'staging'])

    // Names the workspace it asked for, never the default's servers.
    const staging = await (await created.app.request('/api/servers?workspace=staging')).json() as { servers: Array<{ id: string }> }
    expect(staging.servers.map(server => server.id)).toEqual(['api'])
    const fallback = await (await created.app.request('/api/servers')).json() as { servers: Array<{ id: string }> }
    expect(fallback.servers.map(server => server.id)).toEqual(['web'])

    const unknown = await created.app.request('/api/servers?workspace=ghost')
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ code: 'UNKNOWN_WORKSPACE' })
    expect((await created.app.request('/api/servers/ghost/start?workspace=ghost', { method: 'POST' })).status).toBe(404)
  })
})

/**
 * A create without `confirm` answers the plan and writes nothing.
 *
 * This is what lets `home-hosted backup create` plan first: a script or a person reads what would be
 * captured before an archive exists. `confirm=true` is the only way to make one.
 */
describe('/_hh/backups plan mode', () => {
  const token = { 'x-home-hosted-token': 'runtime-token' }

  it('answers a plan, not an archive, when confirm is absent', async () => {
    const created = await fixture()
    const response = await created.app.request('/_hh/backups', { method: 'POST', headers: token })
    expect(response.status).toBe(200)
    const body = await response.json() as { apply?: boolean, entries?: unknown[], file?: unknown }
    expect(body.apply, 'no confirm means plan only').toBe(false)
    expect(Array.isArray(body.entries), 'the plan lists what would be captured').toBe(true)
    expect(body.file, 'nothing was written').toBeUndefined()
  })

  it('narrows the plan to the requested ids', async () => {
    const created = await fixture()
    const response = await created.app.request('/_hh/backups?include=global:settings', { method: 'POST', headers: token })
    expect(response.status).toBe(200)
    const body = await response.json() as { entries?: Array<{ id: string }> }
    expect(body.entries?.map(entry => entry.id)).toEqual(['global:settings'])
  })
})

/**
 * `/_hh/usage` is what `home-hosted usage` prints, so the history it carries is the only way a
 * terminal can tell a flapping entry from a quiet one — a live CPU reading is nearly zero for both.
 *
 * Tested at the route rather than through the CLI: the CLI's own test stubs the panel's answer, so
 * it pins the table's shape and says nothing about whether this builder fills it. The first version
 * of this test was written against the stub and passed with the history block deleted.
 */
describe('/_hh/usage', () => {
  const token = { 'x-home-hosted-token': 'runtime-token' }

  it('carries the history window beside the live readings', async () => {
    const created = await fixture({
      views: [makeView('web', {
        status: 'crashed',
        history: { windowMs: 3_600_000, uptimeRatio: 0.25, restarts: 4, crashes: 9, forcedRestarts: 0, lastCrashAt: null, lastExitAt: 1_700_000_000_000, lastRuntimeMs: null, events: [] },
      })],
    })

    const response = await created.app.request('/_hh/usage', { headers: token })
    expect(response.status).toBe(200)
    const body = await response.json() as { servers: Array<Record<string, unknown>> }

    expect(body.servers[0]).toMatchObject({ id: 'web', crashes: 9, restarts: 4, uptimeRatio: 0.25 })
    // A reading that was never taken stays absent — `0` on a CPU column reads as "idle".
    expect(body.servers[0]).not.toHaveProperty('cpuPercent')
  })
})

/**
 * `/healthz` answers its detail to a caller that can prove it belongs here, and "belongs here"
 * includes the local channel's token — the secret `run.json` hands the CLI.
 *
 * Without that, `status` saw `degraded` but not the count while `usage` read the same numbers over
 * `/_hh`: the gap was `status` using a channel that refused it, not the data being unavailable.
 * The status line itself stays public, which is the whole point of a monitor endpoint.
 */
describe('/healthz detail for the local channel', () => {
  const local = { 'x-home-hosted-token': 'runtime-token' }

  it('answers the counts to the local token', async () => {
    const created = await fixture({ views: [makeView('web', { status: 'running' }), makeView('api')] })
    const body = await (await created.app.request('/healthz', { headers: local })).json() as { servers?: { total: number, running: number } }
    expect(body.servers).toEqual({ total: 2, running: 1, crashed: 0, unhealthy: 0 } as never)
  })

  it('refuses the counts to a wrong token, and to no token', async () => {
    const created = await fixture({ views: [makeView('web')] })

    const wrong = await (await created.app.request('/healthz', { headers: { 'x-home-hosted-token': 'nope' } })).json()
    expect(wrong, 'a wrong token must not unlock the detail').not.toHaveProperty('servers')

    const anonymous = await (await created.app.request('/healthz')).json()
    expect(anonymous, 'the status line stays public').toHaveProperty('status')
    expect(anonymous).not.toHaveProperty('servers')
  })

  /** The local token means "this machine", as on `/_hh`: a leaked copy reads nothing from elsewhere. */
  it('ignores the local token from another machine, or relayed by a proxy', async () => {
    const remote = await fixture({ ip: '10.0.0.5', views: [makeView('web')] })
    expect(await (await remote.app.request('/healthz', { headers: local })).json()).not.toHaveProperty('servers')

    const relayed = await fixture({ views: [makeView('web')] })
    const body = await (await relayed.app.request('/healthz', { headers: { ...local, 'x-forwarded-for': '203.0.113.9' } })).json()
    expect(body).not.toHaveProperty('servers')
  })
})
