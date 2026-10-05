import type { Fixture } from './fixture'
import fs from 'node:fs'
import { type } from 'arktype'
import { afterEach, describe, expect, it } from 'vitest'
import { ddnsViewSchema } from '#src/shared/contracts'
import { makeFixture } from './fixture'

/**
 * Dynamic DNS is workspace-scoped: each workspace keeps its own hostnames,
 * credentials and state, and every route takes `?workspace=<id>` (omitted means the
 * default workspace).
 */

const fixtures: Fixture[] = []

afterEach(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

/** The outbound calls a DDNS pass makes, answered offline. */
async function makeApp(workspaces: Array<{ id: string }> = []): Promise<Fixture> {
  const created = await makeFixture({
    workspaces,
    ddnsFetch: async (url) => {
      if (url.includes('ipify.org'))
        return new Response('203.0.113.7')
      if (url.includes('/zones?name='))
        return new Response(JSON.stringify({ success: true, result: [{ id: 'z', name: 'example.com' }] }), { status: 200 })
      return new Response(JSON.stringify({ success: true, result: [{ id: 'r', content: '9.9.9.9', ttl: 300, proxied: false }] }), { status: 200 })
    },
  })
  fixtures.push(created)
  return created
}

/** What the assertions below read out of a DDNS view. */
interface DdnsBody {
  config: { enabled: boolean, accounts: Array<{ id: string }>, domains: Array<{ host: string }> }
  status: { ipv4: string | null, records: Array<{ host: string, type: string, state: string, ip: string | null }> }
  providers: Array<{ id: string }>
  credentials: string[]
  code?: string
  message?: string
}

async function body<T>(response: Response): Promise<T> {
  return await response.json() as T
}

function put(body: unknown): RequestInit {
  return { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

const configWithAccount = {
  enabled: true,
  accounts: [{ id: 'cf', provider: 'cloudflare', label: 'Home zone' }],
  domains: [{ host: 'home.example.com', account: 'cf', types: ['A'] }],
}

describe('gET /api/ddns', () => {
  it('answers the policy, the providers and the empty credential list', async () => {
    const created = await makeApp()
    const response = await created.app.request('/api/ddns')
    expect(response.status).toBe(200)

    const view = await body<DdnsBody>(response)
    expect(view).toMatchObject({ config: { enabled: false }, credentials: [], status: { records: [] } })
    // `instanceof type.errors`, not `instanceof Error`: ArkType's errors are not Errors, so the
    // latter is false for a valid *and* an invalid payload — the assertion could never fail.
    expect(ddnsViewSchema(view) instanceof type.errors, JSON.stringify(ddnsViewSchema(view))).toBe(false)
    expect(view.providers.map(provider => provider.id)).toContain('cloudflare')
  })

  it('resolves the workspace it names, and 404s one that does not exist', async () => {
    const created = await makeApp([{ id: 'staging' }])
    // The default workspace's policy is one thing; staging starts empty.
    expect((await body<DdnsBody>(await created.app.request('/api/ddns?workspace=staging'))).config.enabled).toBe(false)

    const saved = await created.app.request('/api/ddns?workspace=staging', put(configWithAccount))
    expect(saved.status).toBe(200)
    expect(created.workspaces.get('staging')!.store.ddns.enabled).toBe(true)
    expect(created.store.ddns.enabled).toBe(false)

    const unknown = await created.app.request('/api/ddns?workspace=ghost')
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ code: 'UNKNOWN_WORKSPACE' })
  })
})

describe('pUT /api/ddns', () => {
  it('saves the whole block and lists the configured targets as pending', async () => {
    const created = await makeApp()
    const response = await created.app.request('/api/ddns', put(configWithAccount))
    expect(response.status).toBe(200)

    const view = await body<DdnsBody>(response)
    expect(view.config.accounts).toHaveLength(1)
    expect(view.status.records).toEqual([
      expect.objectContaining({ host: 'home.example.com', type: 'A', state: 'pending' }),
    ])
    expect(created.store.ddns.enabled).toBe(true)
  })

  it('refuses a domain that points at an unknown account', async () => {
    const created = await makeApp()
    const response = await created.app.request('/api/ddns', put({ accounts: [], domains: [{ host: 'a.example.com', account: 'ghost' }] }))
    expect(response.status).toBe(400)
    expect((await body<DdnsBody>(response)).code).toBe('INVALID_DDNS')
  })

  it('refuses a record family the provider cannot manage', async () => {
    const created = await makeApp()
    const response = await created.app.request('/api/ddns', put({
      accounts: [{ id: 'nc', provider: 'namecheap' }],
      domains: [{ host: 'a.example.com', account: 'nc', types: ['AAAA'] }],
    }))
    expect(response.status).toBe(400)
    expect((await body<DdnsBody>(response)).message).toContain('cannot manage AAAA')
  })
})

describe('credentials', () => {
  it('seals them in the workspace secrets file, and never puts them in the config', async () => {
    const created = await makeApp()
    await created.app.request('/api/ddns', put(configWithAccount))

    const response = await created.app.request('/api/ddns/credentials/cf', put({ provider: 'cloudflare', credentials: { apiToken: 'super-secret' } }))
    expect(response.status).toBe(200)
    expect((await body<DdnsBody>(response)).credentials).toEqual(['cf'])
    expect(created.secrets.getDdnsCredentials('cf', 'cloudflare')).toEqual({ provider: 'cloudflare', values: { apiToken: 'super-secret' } })

    // The one credential the panel must replay to a registrar is unreadable at rest.
    const sealed = fs.readFileSync(created.secrets.path, 'utf8')
    expect(sealed).not.toContain('super-secret')
    expect(JSON.parse(sealed).ddns.cf.algo).toBe('aes-256-gcm')
    expect(fs.readFileSync(created.store.path, 'utf8')).not.toContain('super-secret')
  })

  it('keeps each workspace\'s credentials in its own file', async () => {
    const created = await makeApp([{ id: 'staging' }])

    await created.app.request('/api/ddns?workspace=staging', put(configWithAccount))
    await created.app.request('/api/ddns/credentials/cf?workspace=staging', put({ provider: 'cloudflare', credentials: { apiToken: 'staging-token' } }))

    expect(created.workspaces.get('staging')!.secrets.ddnsAccountIds).toEqual(['cf'])
    expect(created.secrets.ddnsAccountIds).toEqual([])
    expect(created.secrets.path).not.toBe(created.workspaces.get('staging')!.secrets.path)
  })

  it('accepts credentials for an account that is not saved yet', async () => {
    const created = await makeApp()

    // Exactly the reported flow: the account is still a draft in the UI.
    const response = await created.app.request('/api/ddns/credentials/cf-main', put({ provider: 'cloudflare', credentials: { apiToken: 'draft-token' } }))
    expect(response.status).toBe(200)
    expect((await body<DdnsBody>(response)).credentials).toEqual(['cf-main'])
    expect(created.secrets.getDdnsCredentials('cf-main', 'cloudflare')?.values).toEqual({ apiToken: 'draft-token' })
  })

  it('refuses an unknown provider', async () => {
    const created = await makeApp()
    const response = await created.app.request('/api/ddns/credentials/cf', put({ provider: 'nope', credentials: { apiToken: 'x' } }))
    expect(response.status).toBe(400)
    expect((await body<DdnsBody>(response)).code).toBe('UNKNOWN_DDNS_PROVIDER')
  })

  it('refuses an incomplete credential set', async () => {
    const created = await makeApp()
    await created.app.request('/api/ddns', put(configWithAccount))
    const response = await created.app.request('/api/ddns/credentials/cf', put({ provider: 'cloudflare', credentials: { email: 'a@b.c' } }))
    expect(response.status).toBe(400)
    expect((await body<DdnsBody>(response)).code).toBe('INVALID_DDNS_CREDENTIALS')
  })

  it('does not advertise an entry stored for another provider', async () => {
    const created = await makeApp()
    await created.app.request('/api/ddns', put(configWithAccount))

    // `cf` is a cloudflare account; a namecheap secret under that id is not usable.
    const response = await created.app.request('/api/ddns/credentials/cf', put({ provider: 'namecheap', credentials: { password: 'pw' } }))
    expect((await body<DdnsBody>(response)).credentials).toEqual([])
    expect(created.secrets.getDdnsCredentials('cf', 'cloudflare')).toBeNull()
  })

  it('drops the secret of an account the config no longer declares', async () => {
    const created = await makeApp()
    await created.app.request('/api/ddns', put(configWithAccount))
    await created.app.request('/api/ddns/credentials/cf', put({ provider: 'cloudflare', credentials: { apiToken: 'x' } }))

    const response = await created.app.request('/api/ddns', put({ enabled: true, accounts: [], domains: [] }))
    expect((await body<DdnsBody>(response)).credentials).toEqual([])
    expect(created.secrets.getDdnsCredentials('cf', 'cloudflare')).toBeNull()
  })

  it('forgets them on delete', async () => {
    const created = await makeApp()
    await created.app.request('/api/ddns', put(configWithAccount))
    await created.app.request('/api/ddns/credentials/cf', put({ provider: 'cloudflare', credentials: { apiToken: 'x' } }))

    const response = await created.app.request('/api/ddns/credentials/cf', { method: 'DELETE' })
    expect(response.status).toBe(200)
    expect((await body<DdnsBody>(response)).credentials).toEqual([])
    expect(created.secrets.getDdnsCredentials('cf', 'cloudflare')).toBeNull()
  })
})

describe('pOST /api/ddns/check', () => {
  it('runs a pass and reports each record', async () => {
    const created = await makeApp()
    await created.app.request('/api/ddns', put(configWithAccount))
    await created.app.request('/api/ddns/credentials/cf', put({ provider: 'cloudflare', credentials: { apiToken: 'x' } }))

    const response = await created.app.request('/api/ddns/check', { method: 'POST' })
    expect(response.status).toBe(200)

    const view = await body<DdnsBody>(response)
    expect(view.status.records).toEqual([
      expect.objectContaining({ host: 'home.example.com', type: 'A', state: 'ok', ip: '203.0.113.7' }),
    ])
    expect(view.status.ipv4).toBe('203.0.113.7')
  })

  it('only runs against the workspace it names', async () => {
    const created = await makeApp([{ id: 'staging' }])
    await created.app.request('/api/ddns?workspace=staging', put(configWithAccount))
    await created.app.request('/api/ddns/credentials/cf?workspace=staging', put({ provider: 'cloudflare', credentials: { apiToken: 'x' } }))

    const response = await created.app.request('/api/ddns/check?workspace=staging', { method: 'POST' })
    expect(response.status).toBe(200)
    expect((await body<DdnsBody>(response)).status.records).toEqual([
      expect.objectContaining({ host: 'home.example.com', type: 'A', state: 'ok' }),
    ])
    expect(created.ddns.view.records).toEqual([])
  })
})
