import type { AppState } from '#src/shared/contracts'
import type { Fixture } from './fixture'
import fs from 'node:fs'
import path from 'node:path'
import { type } from 'arktype'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { missingServer } from '#src/helpers/action-result'
import { serverSchema } from '#src/shared/contracts'
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

  it('reports degraded with 503 when an autostart server has crashed', async () => {
    const created = await fixture({
      views: [makeView('web', { status: 'crashed', config: { id: 'web', command: 'node', autostart: true } as never })],
    })

    const response = await created.app.request('/healthz')
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: 'degraded' })
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
    expect(text).toContain('hh_servers_total 2')
    // A server id repeats across workspaces, so every sample names both.
    expect(text).toContain('hh_server_up{server="web",workspace="default"} 1')
    expect(text).toContain('hh_server_up{server="idle",workspace="default"} 0')
    expect(text).toContain('hh_server_restarts_total{server="web",workspace="default"} 2')
    expect(text).toContain('hh_server_response_ms{server="web",workspace="default"} 12')
    expect(text).toContain('hh_server_rss_bytes{server="web",workspace="default"} 1024')
    expect(text).toContain('hh_server_cpu_percent{server="web",workspace="default"} 3.5')

    // No reading means no series at all, not a zero that reads as "healthy".
    expect(text).not.toContain('hh_server_response_ms{server="idle"')
    expect(text).not.toContain('hh_server_rss_bytes{server="idle"')
    expect(text).not.toContain('hh_server_uptime_ratio_24h')
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
    const patched = { ...view, disks: [{ path: 'C:\\Users\\me', totalBytes: 100, freeBytes: 50, usedPercent: 50 }] }
    vi.spyOn(created.panel, 'getState').mockReturnValue({ ...created.panel.getState(), host: patched })

    const text = await (await created.app.request('/api/metrics')).text()
    const line = text.split('\n').find(entry => entry.startsWith('hh_host_disk_used_percent'))
    expect(line).toBeDefined()
    // Every backslash is doubled, so no bare `\U` survives.
    expect(line).toContain('mount="C:\\\\Users\\\\me"')
    expect(line).not.toContain('C:\\Users\\me')
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
    expect(await refused.json()).toEqual({ ok: false, error: 'server "web" is disabled' })

    const missing = await created.app.request('/_hh/servers/nope/stop', { method: 'POST', headers: local })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ ok: false, error: 'unknown server "nope"' })
  })
})

describe('static UI', () => {
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
