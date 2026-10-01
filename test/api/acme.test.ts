import type { Fixture } from './fixture'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeFixture } from './fixture'

/**
 * The engine's DNS-01 channel. Nothing here starts an engine: the point is that the
 * panel writes the challenge record through the workspace account a route names, and
 * that only the local engine can ask it to.
 */

const fixtures: Fixture[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

async function makeApp(ip?: string | null): Promise<Fixture> {
  const created = await makeFixture(ip === undefined ? {} : { ip })
  fixtures.push(created)
  return created
}

/** A Cloudflare that answers the zone walk, the TXT list and the write. */
function stubCloudflare(existing = false): { calls: string[], bodies: unknown[] } {
  const calls: string[] = []
  const bodies: unknown[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (init?.body !== undefined)
      bodies.push(JSON.parse(String(init.body)))
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.includes('/zones?name='))
      return url.includes('name=example.com') ? json({ success: true, result: [{ id: 'zone1', name: 'example.com' }] }) : json({ success: true, result: [] })
    if (url.includes('type=TXT'))
      return json({ success: true, result: existing ? [{ id: 'txt1', content: 'v' }] : [] })
    if (init?.method === 'DELETE')
      return json({ success: true, result: {} })
    return json({ success: true, result: { id: 'txt2' } })
  })
  return { calls, bodies }
}

/** The account a route names, and the proxy config that names it. */
function configure(fixture: Fixture, dns01 = true): void {
  const runtime = fixture.workspaces.get(fixture.defaultId)!
  runtime.runtime.store.updateDdns({ accounts: [{ id: 'cf', provider: 'cloudflare', label: '' }] })
  runtime.secrets.setDdnsCredentials('cf', 'cloudflare', { apiToken: 'tok' })
  // Written straight to the store, so a config that the save guard would refuse (a
  // named account with the feature off) is still exercised.
  fixture.settings.updateProxy({
    enabled: true,
    dns01: { enabled: dns01 },
    routes: [{ id: 'git', host: 'git.example.com', target: 'external', url: 'http://10.0.0.5:3000', dnsAccount: 'cf' }],
  })
}

/**
 * The credentials the panel generated for the engine, as the engine would read them.
 *
 * They are written lazily — only a panel with DNS-01 on has any — so one request is
 * what brings the file into being. That request is refused, which is the point: the
 * panel generates the pair while checking a caller it cannot authenticate yet.
 */
async function engineAuth(fixture: Fixture): Promise<string> {
  const file = path.join(fixture.dir, '.hh', '.proxy', 'state', 'challenge.json')
  if (!fs.existsSync(file))
    await fixture.app.request('/_acme/present', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const auth = JSON.parse(fs.readFileSync(file, 'utf8')) as { username: string, password: string }
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
}

async function challenge(fixture: Fixture, body: unknown, authorization?: string): Promise<Response> {
  return await fixture.app.request('/_acme/present', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify(body),
  })
}

describe('the engine DNS-01 channel', () => {
  it('writes the challenge record through the account the route names', async () => {
    const fixture = await makeApp()
    configure(fixture)
    const cloudflare = stubCloudflare()

    const response = await challenge(
      fixture,
      { fqdn: '_acme-challenge.git.example.com.', value: 'token-1' },
      await engineAuth(fixture),
    )

    expect(response.status).toBe(200)
    // libdns checks that the reply echoes what it sent.
    expect(await response.json()).toEqual({ fqdn: '_acme-challenge.git.example.com.', value: 'token-1' })
    expect(cloudflare.bodies).toContainEqual({ type: 'TXT', name: '_acme-challenge.git.example.com', content: 'token-1', ttl: 1 })
  })

  it('refuses a caller that is not this machine', async () => {
    const fixture = await makeApp('192.0.2.10')
    configure(fixture)
    stubCloudflare()
    // Write the credentials as the engine's own loopback call would, then make the
    // same call from elsewhere: the peer check is what has to refuse it.
    const file = path.join(fixture.dir, '.hh', '.proxy', 'state', 'challenge.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ username: 'hh', password: 'generated' }))
    const auth = `Basic ${Buffer.from('hh:generated').toString('base64')}`

    const response = await challenge(fixture, { fqdn: '_acme-challenge.git.example.com.', value: 'token-1' }, auth)
    expect(response.status).toBe(403)
  })

  it('writes nothing at all while DNS-01 is off, even for a name a route claims', async () => {
    const fixture = await makeApp()
    configure(fixture, false)
    const cloudflare = stubCloudflare()

    // No credentials are generated while the feature is off, so the caller has none
    // to send — and the endpoint must refuse rather than fall through to a write.
    const response = await challenge(fixture, { fqdn: '_acme-challenge.git.example.com.', value: 'token-1' })

    expect(response.status).toBe(403)
    expect(cloudflare.calls).toEqual([])
  })

  it('refuses the local engine without the generated credentials', async () => {
    const fixture = await makeApp()
    configure(fixture)
    stubCloudflare()

    const response = await challenge(fixture, { fqdn: '_acme-challenge.git.example.com.', value: 'token-1' })
    expect(response.status).toBe(401)
  })

  it('says so when no route claims the name', async () => {
    const fixture = await makeApp()
    configure(fixture)
    stubCloudflare()

    const response = await challenge(
      fixture,
      { fqdn: '_acme-challenge.other.example.net.', value: 'token-1' },
      await engineAuth(fixture),
    )
    expect(response.status).toBe(404)
  })
})
