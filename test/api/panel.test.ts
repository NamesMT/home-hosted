import type { Fixture } from './fixture'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
    expect(await response.json()).toMatchObject({ configPath: created.store.path })
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
    created.store.updateControl({ host: 'lan', auth: { enabled: false } })
    const cookie = await signIn(created, 'correct horse')

    const response = await created.app.request('/api/auth/password', { method: 'DELETE', headers: { cookie } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'EXPOSED_WITHOUT_PASSWORD' })
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
      views: [makeView('web', { status: 'crashed', config: { id: 'web', autostart: true } as never })],
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
        makeView('web', { status: 'running', restarts: 2, responseMs: 12, resources: { rssBytes: 1024, cpuPercent: 3.5 } as never }),
        makeView('idle'),
      ],
    })

    const response = await created.app.request('/api/metrics')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')

    const text = await response.text()
    expect(text).toContain('hh_control_up 1')
    expect(text).toContain('hh_servers_total 2')
    expect(text).toContain('hh_server_up{server="web"} 1')
    expect(text).toContain('hh_server_up{server="idle"} 0')
    expect(text).toContain('hh_server_restarts_total{server="web"} 2')
    expect(text).toContain('hh_server_response_ms{server="web"} 12')
    expect(text).toContain('hh_server_rss_bytes{server="web"} 1024')
    expect(text).toContain('hh_server_cpu_percent{server="web"} 3.5')

    // No reading means no series at all, not a zero that reads as "healthy".
    expect(text).not.toContain('hh_server_response_ms{server="idle"}')
    expect(text).not.toContain('hh_server_rss_bytes{server="idle"}')
    expect(text).not.toContain('hh_server_uptime_ratio_24h')
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

    for (const url of ['/%2e%2e/secret.txt', '/assets/%2e%2e%2f%2e%2e/secret.txt', '/..%2fsecret.txt']) {
      const response = await created.app.request(url)
      const body = await response.text()
      expect(body, url).not.toContain('do-not-serve-me')
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
      '/api/logs',
      '/api/backups',
      '/healthz',
    ]))
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

    created.store.updateControl({ auth: { cookieSecure: 'always' } })
    const always = await form(created.app, '/api/auth/login', 'POST', { password: 'correct horse' })
    expect(always.headers.get('set-cookie')).toMatch(/;\s*Secure/i)

    created.store.updateControl({ auth: { cookieSecure: 'never' } })
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
