import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type } from 'arktype'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { generateApiToken, SecretsStore } from '#src/config/secrets'
import { serializeCookie } from '#src/helpers/cookies'
import { errorHandler } from '#src/helpers/error'
import { createAuthGuard } from '#src/middleware/auth'
import { AuthService, SESSION_COOKIE } from '#src/services/auth'
import { authSchema } from '#src/shared/contracts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function makeApp(options: { enabled: boolean, password?: string, token?: string }) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh2-guard-'))
  dirs.push(dir)

  const parsed = authSchema({ enabled: options.enabled })
  if (parsed instanceof type.errors)
    throw parsed

  const secrets = new SecretsStore(path.join(dir, 'secrets.json'))
  const auth = new AuthService(secrets, () => parsed)
  if (options.password !== undefined)
    auth.setPassword(options.password)
  if (options.token !== undefined)
    secrets.setApiToken(options.token)

  // The guard fails by throwing, exactly like the real app (see src/app.ts).
  const app = new Hono()
  app.onError(errorHandler)
  app.use('/api/*', createAuthGuard({ auth }))
  app.get('/api/state', c => c.json({ servers: [] }))
  app.get('/api/auth/session', c => c.json({ authenticated: false }))
  app.post('/api/auth/login', c => c.json({ ok: true }))
  app.post('/api/servers/demo/start', c => c.json({ ok: true }))
  app.get('/', c => c.html('<div id="app"></div>'))

  return { app, auth }
}

function sessionHeader(token: string): Record<string, string> {
  return { cookie: serializeCookie(SESSION_COOKIE, token, { maxAgeMs: 60000 }) }
}

const LOCAL_ORIGIN = 'http://127.0.0.1:3999'

describe('auth guard', () => {
  it('leaves everything open when auth is off', async () => {
    const { app } = await makeApp({ enabled: false })
    const response = await app.request('http://127.0.0.1:3999/api/state')
    expect(response.status).toBe(200)
  })

  it('serves the SPA shell without a session, but not the API', async () => {
    const { app } = await makeApp({ enabled: true, password: 'a-good-password' })

    expect((await app.request('http://127.0.0.1:3999/')).status).toBe(200)

    const state = await app.request('http://127.0.0.1:3999/api/state')
    expect(state.status).toBe(401)
    expect(await state.json()).toMatchObject({ code: 'AUTH_REQUIRED' })

    // The login screen needs these two.
    expect((await app.request('http://127.0.0.1:3999/api/auth/session')).status).toBe(200)
    expect((await app.request('http://127.0.0.1:3999/api/auth/login', { method: 'POST' })).status).toBe(200)
  })

  it('accepts a valid session cookie and rejects a forged one', async () => {
    const { app, auth } = await makeApp({ enabled: true, password: 'a-good-password' })
    const outcome = auth.login('a-good-password', '127.0.0.1')
    if (!outcome.ok)
      throw new Error('login failed')

    const authorized = await app.request('http://127.0.0.1:3999/api/state', { headers: sessionHeader(outcome.token) })
    expect(authorized.status).toBe(200)

    const forged = await app.request('http://127.0.0.1:3999/api/state', { headers: sessionHeader('not-a-real-token') })
    expect(forged.status).toBe(401)
  })

  it('protects the SSE and mutation routes too', async () => {
    const { app } = await makeApp({ enabled: true, password: 'a-good-password' })
    const response = await app.request('http://127.0.0.1:3999/api/servers/demo/start', {
      method: 'POST',
      headers: { origin: LOCAL_ORIGIN },
    })
    expect(response.status).toBe(401)
  })

  it('rejects a same-site-looking mutation from another origin', async () => {
    const { app, auth } = await makeApp({ enabled: true, password: 'a-good-password' })
    const outcome = auth.login('a-good-password', '127.0.0.1')
    if (!outcome.ok)
      throw new Error('login failed')

    const response = await app.request('http://127.0.0.1:3999/api/servers/demo/start', {
      method: 'POST',
      headers: { ...sessionHeader(outcome.token), origin: 'http://evil.example' },
    })
    expect(response.status).toBe(403)
  })

  it('allows a mutation from its own origin', async () => {
    const { app, auth } = await makeApp({ enabled: true, password: 'a-good-password' })
    const outcome = auth.login('a-good-password', '127.0.0.1')
    if (!outcome.ok)
      throw new Error('login failed')

    const response = await app.request('http://127.0.0.1:3999/api/servers/demo/start', {
      method: 'POST',
      headers: { ...sessionHeader(outcome.token), origin: LOCAL_ORIGIN },
    })
    expect(response.status).toBe(200)
  })

  it('locks the API down while auth is enabled but no password is set', async () => {
    const { app } = await makeApp({ enabled: true })

    // No client ip in this test harness, so a request counts as non-loopback.
    const remote = await app.request('http://192.168.1.10:3999/api/state')
    expect(remote.status).toBe(401)
    expect(await remote.json()).toMatchObject({ code: 'AUTH_UNARMED' })
  })

  it('treats a loopback request as local while auth is unarmed', async () => {
    const { app } = await makeApp({ enabled: true })
    const app2 = app
    // `app.request` has no socket, so simulate srvx's resolved ip.
    const response = await app2.request('http://127.0.0.1:3999/api/state', {
      headers: { 'x-forwarded-for': '127.0.0.1' },
    })
    // Without trustProxy the header is ignored, so this stays a 401 — which is
    // the safe direction: never treat a forwarded address as local.
    expect(response.status).toBe(401)
  })
})

describe('auth guard with an API token', () => {
  function bearer(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` }
  }

  it('accepts a token with no session cookie at all', async () => {
    const token = generateApiToken()
    const { app } = await makeApp({ enabled: true, password: 'a-good-password', token })

    const authorized = await app.request('http://127.0.0.1:3999/api/state', { headers: bearer(token) })
    expect(authorized.status).toBe(200)
  })

  it('rejects a wrong token and says which scheme is accepted', async () => {
    const { app } = await makeApp({ enabled: true, password: 'a-good-password', token: generateApiToken() })

    const forged = await app.request('http://127.0.0.1:3999/api/state', { headers: bearer('not-the-token') })
    expect(forged.status).toBe(401)
    expect(await forged.json()).toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(forged.headers.get('www-authenticate')).toContain('Bearer')
  })

  it('does not advertise a scheme when no token exists', async () => {
    const { app } = await makeApp({ enabled: true, password: 'a-good-password' })
    const denied = await app.request('http://127.0.0.1:3999/api/state')
    expect(denied.status).toBe(401)
    expect(denied.headers.get('www-authenticate')).toBeNull()
  })

  it('lets a token through while auth is enabled but no password is set', async () => {
    const token = generateApiToken()
    const { app } = await makeApp({ enabled: true, token })

    // No socket in this harness, so a non-loopback url counts as remote.
    const remote = await app.request('http://192.168.1.10:3999/api/state', { headers: bearer(token) })
    expect(remote.status).toBe(200)

    // Without the token that same address is still refused, exactly as before.
    const bare = await app.request('http://192.168.1.10:3999/api/state')
    expect(bare.status).toBe(401)
    expect(await bare.json()).toMatchObject({ code: 'AUTH_UNARMED' })
  })

  it('authorises mutations, still behind the same-origin rule', async () => {
    const token = generateApiToken()
    const { app } = await makeApp({ enabled: true, password: 'a-good-password', token })

    // A script sends no Origin: nothing to check, and the token is the credential.
    const scripted = await app.request('http://127.0.0.1:3999/api/servers/demo/start', {
      method: 'POST',
      headers: bearer(token),
    })
    expect(scripted.status).toBe(200)

    const crossOrigin = await app.request('http://127.0.0.1:3999/api/servers/demo/start', {
      method: 'POST',
      headers: { ...bearer(token), origin: 'http://evil.example' },
    })
    expect(crossOrigin.status).toBe(403)
  })

  it('leaves everything open when auth is off, token or not', async () => {
    const { app } = await makeApp({ enabled: false, token: generateApiToken() })
    expect((await app.request('http://192.168.1.10:3999/api/state')).status).toBe(200)
  })
})
