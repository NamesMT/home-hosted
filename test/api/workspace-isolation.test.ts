import type { Fixture } from './fixture'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFixture, makeView } from './fixture'

/**
 * A credential limited to one workspace must not reach another — on **every** route.
 *
 * `narrowStateFor` and `narrowProxyFor` each carry a long comment about a specific leak they fixed
 * (`GET /api/proxy` handing a `staging`-limited account `default`'s routes, id, public hostname and
 * upstream included), and `workspaceLimit` is applied per route. What nothing did was check the whole
 * surface at once, so a route added later could be missing its `workspaceLimit` call and no test would
 * notice — the same "guard over the routes somebody remembered" shape as the `windowsHide` scan.
 *
 * This sweeps every workspace-scoped read and every write as a `staging`-only account, and fails if any
 * of them either succeeds or returns `default`'s data.
 */
const fixtures: Fixture[] = []

async function fixture(): Promise<Fixture> {
  return makeFixture({
    password: 'admin-secret-123',
    views: [makeView('default-web')],
    workspaces: [{ id: 'staging', label: 'Staging' }],
    servers: [{ id: 'default-web', command: 'node', args: ['-e', '0'] }],
  })
}

afterEach(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

/** Signs in and returns the cookie header a browser would send back. */
async function signIn(created: Fixture, id: string, secret: string): Promise<string> {
  const response = await created.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, secret }),
  })
  expect(response.status, `login as ${id}`).toBe(200)
  const cookie = response.headers.get('set-cookie')
  expect(cookie, `login as ${id} set no cookie`).toContain('hh_session=')
  return cookie!.split(';')[0]!
}

describe('a workspace-limited credential cannot reach another workspace', () => {
  it('refuses every write into a workspace it may not touch', async () => {
    const created = await fixture()
    fixtures.push(created)

    // An account confined to `staging`, with every scope — so the only thing refusing these is the
    // workspace limit, not a missing permission.
    const secret = 'limited-secret-123'
    created.globalSecrets.createAccount({ id: 'limited', label: 'limited', scopes: ['read', 'lifecycle', 'config', 'proxy', 'admin'], secret, workspaces: ['staging'] })
    const cookie = await signIn(created, 'limited', secret)

    const writes: Array<[string, string, unknown]> = [
      ['POST', '/api/servers?workspace=default', { id: 'evil', command: 'node', args: ['-e', '0'] }],
      ['POST', '/api/servers/default-web/start?workspace=default', undefined],
      ['POST', '/api/servers/default-web/stop?workspace=default', undefined],
      ['PATCH', '/api/servers/default-web?workspace=default', { label: 'pwned' }],
      ['DELETE', '/api/servers/default-web?workspace=default', undefined],
      ['PATCH', '/api/settings?workspace=default', { notifications: { destinations: [] } }],
      /**
       * A route that **names** another workspace is refused; an empty list names none and is allowed.
       *
       * `src/api/proxy.ts` states the rule: the rows a credential may not touch are kept in place and a
       * row naming a workspace outside the limit is refused, while panel-wide knobs (ports, the engine,
       * certificates) are the panel's and a limit does not reach them. So this case uses a route that
       * acts on `default`, which is the write the leak was about — a patch *replaces* the list, so a
       * `staging`-limited account sending its own route deleted every other workspace's.
       */
      ['PATCH', '/api/proxy', { routes: [{ id: 'pwn', host: 'pwn.example.test', target: 'server', workspace: 'default', server: 'default-web', tls: 'off' }] }],
      ['DELETE', '/api/workspaces/default', undefined],
    ]

    const allowed: string[] = []
    for (const [method, path, body] of writes) {
      const response = await created.app.request(path, {
        method,
        headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      // 403 is the refusal; anything under 400 means the write was accepted.
      if (response.status < 400)
        allowed.push(`${method} ${path} → ${response.status}`)
    }
    expect(allowed, 'a workspace-limited credential wrote into another workspace').toEqual([])
  })

  it('answers no workspace-scoped read for a workspace it may not touch', async () => {
    const created = await fixture()
    fixtures.push(created)

    const secret = 'limited-secret-123'
    created.globalSecrets.createAccount({ id: 'limited', label: 'limited', scopes: ['read'], secret, workspaces: ['staging'] })
    const cookie = await signIn(created, 'limited', secret)

    const reads = [
      '/api/servers?workspace=default',
      '/api/jobs?workspace=default',
      '/api/logs?id=default-web&workspace=default',
      '/api/backups?workspace=default',
      '/api/ddns?workspace=default',
    ]

    const served: string[] = []
    for (const path of reads) {
      const response = await created.app.request(path, { headers: { cookie } })
      if (response.status < 400)
        served.push(`${path} → ${response.status}`)
    }
    expect(served, 'a workspace-limited credential read another workspace').toEqual([])
  })

  it('carries only the workspaces it may read in the snapshots', async () => {
    // The panel-wide routes answer 200, so the limit shows up as *narrowing* rather than a refusal.
    const created = await fixture()
    fixtures.push(created)

    const secret = 'limited-secret-123'
    created.globalSecrets.createAccount({ id: 'limited', label: 'limited', scopes: ['read'], secret, workspaces: ['staging'] })
    const cookie = await signIn(created, 'limited', secret)

    const state = await created.app.request('/api/state', { headers: { cookie } })
    expect(state.status).toBe(200)
    const body = await state.json() as { workspaces: Array<{ id: string }> }
    expect(body.workspaces.map(workspace => workspace.id), 'the frame named a workspace the credential may not read').toEqual(['staging'])

    // And the proxy view, which is panel-wide with an empty query and once leaked the route table.
    const proxy = await created.app.request('/api/proxy', { headers: { cookie } })
    expect(proxy.status).toBe(200)
    const view = await proxy.json() as { routes?: Array<{ route: { workspace: string } }> }
    for (const entry of view.routes ?? []) {
      expect(
        entry.route.workspace === '' || entry.route.workspace === 'staging',
        `the proxy view named another workspace's route: ${entry.route.workspace}`,
      ).toBe(true)
    }
  })
})
