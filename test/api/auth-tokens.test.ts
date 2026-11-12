import type { Fixture } from './fixture'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFixture } from './fixture'

/**
 * `POST`/`GET`/`DELETE /api/auth/tokens` — the named, scoped tokens over the API.
 *
 * Session-only, like the single-token routes: a token that could mint its own successor would make a
 * leaked credential impossible to revoke from the panel. And the value is returned **once** — the
 * listing names a token, never shows the thing that authenticates it.
 */

const fixtures: Fixture[] = []

async function fixture(options: Parameters<typeof makeFixture>[0] = {}): Promise<Fixture> {
  const created = await makeFixture({ password: 'a-good-password', ...options })
  fixtures.push(created)
  return created
}

afterEach(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

/** Signs in and returns the cookie header a browser would send back. */
async function signIn(created: Fixture): Promise<Record<string, string>> {
  const response = await created.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'a-good-password' }),
  })
  expect(response.status).toBe(200)
  return { 'cookie': response.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json' }
}

async function mint(created: Fixture, headers: Record<string, string>, body: unknown): Promise<Response> {
  return await created.app.request('/api/auth/tokens', { method: 'POST', headers, body: JSON.stringify(body) })
}

describe('minting a scoped token', () => {
  it('returns the value once and lists it without it', async () => {
    const created = await fixture()
    const headers = await signIn(created)

    const response = await mint(created, headers, { name: 'monitor', scopes: ['read'] })
    expect(response.status).toBe(201)
    const body = await response.json() as { token: string, tokenMeta: { id: string, name: string, scopes: string[] } }
    expect(body.token).toMatch(/^hh_/)
    expect(body.tokenMeta).toMatchObject({ name: 'monitor', scopes: ['read'] })
    // The metadata in the mint answer is metadata: no hash.
    expect(JSON.stringify(body.tokenMeta)).not.toContain(body.token)

    const listed = await created.app.request('/api/auth/tokens', { headers })
    expect(listed.status).toBe(200)
    const { tokens } = await listed.json() as { tokens: Array<{ name: string, id: string, lastUsedAt?: number }> }
    expect(tokens.map(entry => entry.name)).toContain('monitor')
    expect(JSON.stringify(tokens), 'a listing never carries the value').not.toContain(body.token)
  })

  it('refuses a duplicate name with TOKEN_EXISTS', async () => {
    const created = await fixture()
    const headers = await signIn(created)
    expect((await mint(created, headers, { name: 'monitor', scopes: ['read'] })).status).toBe(201)

    const again = await mint(created, headers, { name: 'monitor', scopes: ['admin'] })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ code: 'TOKEN_EXISTS' })
  })

  it('refuses an unknown scope and an undeclared key', async () => {
    const created = await fixture()
    const headers = await signIn(created)
    expect((await mint(created, headers, { name: 'x', scopes: ['root'] })).status).toBe(400)
    expect((await mint(created, headers, { name: 'x', scopes: ['read'], nope: 1 })).status).toBe(400)
  })

  it('refuses a token that tries to mint one', async () => {
    const created = await fixture()
    const headers = await signIn(created)
    const minted = await mint(created, headers, { name: 'agent', scopes: ['admin'] })
    const { token } = await minted.json() as { token: string }

    const refused = await mint(created, { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' }, { name: 'child', scopes: ['read'] })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: 'SESSION_REQUIRED' })
  })
})

describe('revoking one', () => {
  it('stops it working, and 404s an unknown id', async () => {
    const created = await fixture()
    const headers = await signIn(created)
    const { token, tokenMeta } = await (await mint(created, headers, { name: 'gone', scopes: ['read'] })).json() as { token: string, tokenMeta: { id: string } }

    // It works before the revoke.
    expect((await created.app.request('/api/state', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)

    expect((await created.app.request(`/api/auth/tokens/${tokenMeta.id}`, { method: 'DELETE', headers })).status).toBe(200)
    expect((await created.app.request('/api/state', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401)

    const missing = await created.app.request('/api/auth/tokens/ghost', { method: 'DELETE', headers })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 'UNKNOWN_TOKEN' })
  })
})

describe('the old single-token routes', () => {
  it('still work, and act on the token named default', async () => {
    const created = await fixture()
    const headers = await signIn(created)
    // `POST /api/auth/token` rotates `default`, which is what an upgraded home already had.
    const rotated = await created.app.request('/api/auth/token', { method: 'POST', headers })
    expect(rotated.status).toBe(200)
    const { token } = await rotated.json() as { token: string }

    const { tokens } = await (await created.app.request('/api/auth/tokens', { headers })).json() as { tokens: Array<{ id: string, name: string, scopes: string[] }> }
    expect(tokens.find(entry => entry.id === 'default')).toMatchObject({ name: 'default', scopes: ['admin'] })

    // And the rotated value authenticates.
    expect((await created.app.request('/api/state', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)
  })
})
