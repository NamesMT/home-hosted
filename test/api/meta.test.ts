import type { Fixture } from './fixture'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { generateApiToken, SecretsStore } from '#src/config/secrets'
import { ERROR_CODES } from '#src/shared/error-codes'
import { makeFixture, makeView } from './fixture'

/**
 * `GET /api/meta`: what this panel is, who is asking, and what that credential may not do.
 *
 * The point of the route is that a client stops probing for these one at a time, so the tests are
 * about the answer being *derived* rather than declared: `features` follows live settings, `credential`
 * describes the request in hand, `refused` is non-empty only for a credential that is really refused
 * those actions, and `errorCodes` cannot drift from the catalogue because it is the catalogue.
 */

const fixtures: Fixture[] = []

async function fixture(options?: Parameters<typeof makeFixture>[0]): Promise<Fixture> {
  const created = await makeFixture(options)
  fixtures.push(created)
  return created
}

afterAll(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

function setApiToken(created: Fixture, token: string): void {
  new SecretsStore(path.join(created.dir, '.hh', '.control-secrets.json'), undefined, 'global').setApiToken(token)
}

interface Meta {
  version: string
  apiVersion: number
  credential: { kind: string, name?: string }
  actor: string
  refused: string[]
  features: { proxy: boolean, ddns: boolean, temperature: boolean }
  errorCodes: string[]
  events: string[]
}

describe('panel metadata', () => {
  it('reports the release, an API version, and its credential', async () => {
    const created = await fixture({ views: [makeView('web')] })
    const response = await created.app.request('/api/meta')
    expect(response.status).toBe(200)

    const body = await response.json() as Meta
    // The release is the package manifest's, not a literal — a hardcoded one drifts on the next bump.
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(body.apiVersion).toBe(1)
    // No cookie and no token, and this fixture's peer is loopback: this machine.
    expect(body.credential).toEqual({ kind: 'local' })
    expect(body.actor).toBe('user')
  })

  /**
   * `credential.name` is the token's **name** now that tokens are named.
   *
   * It used to be the readable head of the single token, which was the only identity one could have.
   * With several tokens, the name is what tells them apart in a settings page — and the head is still
   * there as the fallback for a token migrated from the pre-0.14 single one, whose only identity was
   * its own value. Either way: **the value never appears**.
   */
  it('names the API token that answered, and never echoes it', async () => {
    const created = await fixture({ views: [makeView('web')] })
    const token = generateApiToken()
    setApiToken(created, token)

    const response = await created.app.request('/api/meta', { headers: { authorization: `Bearer ${token}` } })
    const body = await response.json() as Meta

    expect(body.credential.kind).toBe('token')
    // The legacy single token migrates in as `default`, which is the name this one now has.
    expect(body.credential.name).toBe('default')
    expect(JSON.stringify(body), 'the token itself must never be echoed').not.toContain(token)
    expect(body.actor).toBe('agent')
  })

  it('names a minted token by the name it was minted with', async () => {
    const created = await fixture({ views: [makeView('web')] })
    const { token } = created.globalSecrets.createApiToken({ name: 'monitor', scopes: ['read'] })

    const body = await (await created.app.request('/api/meta', { headers: { authorization: `Bearer ${token}` } })).json() as Meta
    expect(body.credential).toMatchObject({ kind: 'token', name: 'monitor' })
    expect(JSON.stringify(body)).not.toContain(token)
  })

  /**
   * `refused` is the set of actions this credential cannot take, and it is **empty** for anything
   * that is not an API token — a session and this machine may do all of them.
   */
  it('lists what a token may not do, and nothing for a session or this machine', async () => {
    const created = await fixture({ views: [makeView('web')] })
    const local = await (await created.app.request('/api/meta')).json() as Meta
    expect(local.refused).toEqual([])

    const token = generateApiToken()
    setApiToken(created, token)
    const asToken = await (await created.app.request('/api/meta', { headers: { authorization: `Bearer ${token}` } })).json() as Meta

    // Every entry is a refusal that exists in src/api — not a policy invented by this route.
    expect([...asToken.refused].sort()).toEqual([
      'auth.disable',
      'password.clear',
      'password.first',
      'restore.credentials',
      'token.generate',
      'token.revoke',
      'ui.install',
    ])
  })

  it('reports an armed session as a session credential', async () => {
    const created = await fixture({ views: [makeView('web')], password: 'a-long-enough-password' })
    const login = await created.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'a-long-enough-password' }),
    })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!

    const body = await (await created.app.request('/api/meta', { headers: { cookie } })).json() as Meta
    expect(body.credential).toEqual({ kind: 'session' })
    expect(body.refused, 'a session may do everything a token may not').toEqual([])
  })

  /**
   * `features` follows live settings, which is the whole reason the route is not a static document:
   * a person turns the proxy on and the next call must say so.
   */
  it('reports features from the settings that are switched on now', async () => {
    const created = await fixture({ views: [makeView('web')] })
    const before = await (await created.app.request('/api/meta')).json() as Meta
    expect(before.features).toEqual({ proxy: false, ddns: false, temperature: false })

    created.settings.updateProxy({ enabled: true })
    created.settings.updateHost({ tempCommand: 'cat /tmp/temp' })

    const after = await (await created.app.request('/api/meta')).json() as Meta
    expect(after.features.proxy, 'the proxy is on in settings now').toBe(true)
    expect(after.features.temperature, 'a tempCommand is configured').toBe(true)
    expect(after.features.ddns, 'left off').toBe(false)
  })

  it('reports ddns on when any workspace has it enabled', async () => {
    const created = await fixture({
      views: [makeView('web')],
      workspaces: [{ id: 'staging', label: 'Staging', servers: [{ id: 'api', command: 'node' }] }],
      workspaceViews: { staging: [makeView('api')] },
    })
    // Turned on through the route a person uses, so the feature flag follows the real write path.
    const saved = await created.app.request('/api/ddns?workspace=staging', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(saved.status).toBe(200)

    const body = await (await created.app.request('/api/meta')).json() as Meta
    expect(body.features.ddns).toBe(true)
  })

  /** The catalogue is the single owner, so a code added there appears here without a second list. */
  it('reports every error code from the catalogue itself', async () => {
    const created = await fixture({ views: [makeView('web')] })
    const body = await (await created.app.request('/api/meta')).json() as Meta

    expect(body.errorCodes.sort()).toEqual(Object.keys(ERROR_CODES).sort())
    expect(body.errorCodes).toContain('SESSION_REQUIRED')
    expect(body.errorCodes).toContain('CURSOR_OUT_OF_RANGE')
  })

  it('reports the SSE event names its streams send', async () => {
    const created = await fixture({ views: [makeView('web')] })
    const body = await (await created.app.request('/api/meta')).json() as Meta
    expect(body.events).toEqual(['hello', 'state', 'server', 'log', 'ping'])
  })

  it('refuses an undeclared query key, like every other panel-wide route', async () => {
    const created = await fixture({ views: [makeView('web')] })
    const response = await created.app.request('/api/meta?worspace=staging')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('is documented in the OpenAPI spec with the shape it answers', async () => {
    const created = await fixture({ views: [makeView('web')] })
    const spec = await (await created.app.request('/openapi/spec.json')).json() as {
      paths: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> } | undefined>>
    }
    const operation = spec.paths['/api/meta']?.get
    expect(operation, 'GET /api/meta is documented').toBeDefined()
    const schema = operation!.responses!['200']!.content!['application/json']!.schema
    expect(schema, 'with a bound response schema').toBeDefined()
  })
})

describe('the session route’s credential field', () => {
  it('says which credential answered', async () => {
    const created = await fixture({ views: [makeView('web')] })
    const local = await (await created.app.request('/api/auth/session')).json() as { credential?: { kind: string } }
    expect(local.credential).toEqual({ kind: 'local' })

    const token = generateApiToken()
    setApiToken(created, token)
    const viaToken = await (await created.app.request('/api/auth/session', { headers: { authorization: `Bearer ${token}` } })).json() as { credential?: { kind: string, name?: string } }
    expect(viaToken.credential?.kind).toBe('token')
    expect(JSON.stringify(viaToken)).not.toContain(token)
  })

  /** Signed in, the session route says `session` — and `defaultPassword` is absent, never `null`. */
  it('reports a cookie session, and never sends a defaultPassword', async () => {
    const created = await fixture({ views: [makeView('web')], password: 'a-long-enough-password' })
    const body = await (await created.app.request('/api/auth/session')).json() as Record<string, unknown>
    expect(body).not.toHaveProperty('defaultPassword')

    const login = await created.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'a-long-enough-password' }),
    })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const signedIn = await (await created.app.request('/api/auth/session', { headers: { cookie } })).json() as { credential?: { kind: string } }
    expect(signedIn.credential).toEqual({ kind: 'session' })
  })
})
