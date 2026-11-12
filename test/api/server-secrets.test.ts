import type { Fixture } from './fixture'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFixture, makeView } from './fixture'

/**
 * `PUT /api/servers/:id/secrets` is write-only, and the value never comes back out.
 *
 * A server's secrets live in the workspace's `.secrets.json`; the names are declared on the entry.
 * The one rule this file exists for: **no response, ever, carries a value**. The view reports which
 * names are set (`secretEnvSet`), a write answers `ok`, and nothing echoes what was written — not in
 * the body, not in `/api/state`, not in the server view, not in a log line.
 */

const fixtures: Fixture[] = []

async function fixture(options: Parameters<typeof makeFixture>[0] = {}): Promise<Fixture> {
  const created = await makeFixture(options)
  fixtures.push(created)
  return created
}

afterEach(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

async function withServer(): Promise<Fixture> {
  return fixture({
    servers: [{ id: 'web', command: 'node', secretEnv: ['DATABASE_URL'] }],
    views: [makeView('web', { config: { id: 'web', command: 'node', secretEnv: ['DATABASE_URL'] } as never })],
  })
}

async function putSecrets(created: Fixture, id: string, body: unknown, workspace?: string): Promise<Response> {
  const query = workspace === undefined ? '' : `?workspace=${workspace}`
  return await created.app.request(`/api/servers/${id}/secrets${query}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('pUT /api/servers/:id/secrets', () => {
  it('writes the value, and answers without it', async () => {
    const created = await withServer()
    const response = await putSecrets(created, 'web', { set: { DATABASE_URL: 'postgres://u:p@db/app' } })

    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body).toMatchObject({ ok: true })
    // Nothing in the answer may carry the value — the whole point of a write-only route.
    expect(JSON.stringify(body)).not.toContain('postgres://u:p@db/app')
  })

  it('is not readable back through any response', async () => {
    const created = await withServer()
    await putSecrets(created, 'web', { set: { DATABASE_URL: 'postgres://u:p@db/app' } })

    for (const url of ['/api/state', '/api/servers', '/api/servers/web']) {
      const text = await (await created.app.request(url)).text()
      expect(text, `${url} must not carry a secret value`).not.toContain('postgres://u:p@db/app')
    }
    // The names are fine — that is what tells a person a value exists.
    expect(await (await created.app.request('/api/servers/web')).text()).toContain('secretEnvSet')
  })

  it('unsets one name and leaves the rest', async () => {
    const created = await fixture({
      servers: [{ id: 'web', command: 'node', secretEnv: ['A', 'B'] }],
      views: [makeView('web', { config: { id: 'web', command: 'node', secretEnv: ['A', 'B'] } as never })],
    })
    await putSecrets(created, 'web', { set: { A: '1', B: '2' } })
    expect((await (await created.app.request('/api/servers/web')).json() as { server: { secretEnvSet: string[] } }).server.secretEnvSet.sort()).toEqual(['A', 'B'])

    const response = await putSecrets(created, 'web', { unset: ['A'] })
    expect(response.status).toBe(200)
    expect((await (await created.app.request('/api/servers/web')).json() as { server: { secretEnvSet: string[] } }).server.secretEnvSet).toEqual(['B'])
  })

  it('refuses a name the entry does not declare', async () => {
    const created = await withServer()
    const response = await putSecrets(created, 'web', { set: { NOT_DECLARED: 'x' } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('refuses a name that is not an environment-variable name', async () => {
    const created = await withServer()
    const response = await putSecrets(created, 'web', { set: { 'BAD-NAME': 'x' } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('404s an unknown server, and an unknown workspace', async () => {
    const created = await withServer()
    expect((await putSecrets(created, 'ghost', { set: { A: '1' } })).status).toBe(404)
    expect((await putSecrets(created, 'web', { set: { DATABASE_URL: 'x' } }, 'nope')).status).toBe(404)
  })
})
