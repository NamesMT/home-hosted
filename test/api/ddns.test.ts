import type { AppDeps } from '#src/app'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { createDdnsRoute } from '#src/api/ddns'
import { SecretsStore } from '#src/config/secrets'
import { ConfigStore } from '#src/config/store'
import { errorHandler } from '#src/helpers/error'
import { DdnsService } from '#src/services/ddns'
import { NotificationService } from '#src/services/notifications'
import { ddnsViewSchema } from '#src/shared/contracts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

interface Fixture {
  app: Hono
  dir: string
  file: string
  secretsFile: string
  store: ConfigStore
  secrets: SecretsStore
}

async function makeApp(): Promise<Fixture> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-ddns-api-'))
  dirs.push(dir)

  const file = path.join(dir, 'servers.config.json')
  const store = new ConfigStore(file)
  store.load()

  const secretsFile = path.join(dir, '.control-secrets.json')
  const secrets = new SecretsStore(secretsFile)
  const notifications = new NotificationService(secrets, () => store.config.notifications, () => store.config.logs)
  const ddns = new DdnsService({
    getConfig: () => store.config.ddns,
    getCredentials: accountId => secrets.getDdnsCredentials(accountId),
    notifications,
    statePath: path.join(dir, 'ddns.json'),
    fetchImpl: async (url) => {
      if (url.includes('ipify.org'))
        return new Response('203.0.113.7')
      if (url.includes('/zones?name='))
        return new Response(JSON.stringify({ success: true, result: [{ id: 'z', name: 'example.com' }] }), { status: 200 })
      return new Response(JSON.stringify({ success: true, result: [{ id: 'r', content: '9.9.9.9', ttl: 300, proxied: false }] }), { status: 200 })
    },
  })

  const deps = { store, secrets, notifications, ddns } as unknown as AppDeps
  const app = new Hono().onError(errorHandler).route('/api', createDdnsRoute(deps))
  return { app, dir, file, secretsFile, store, secrets }
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
    const { app } = await makeApp()
    const response = await app.request('/api/ddns')
    expect(response.status).toBe(200)

    const view = await body<DdnsBody>(response)
    expect(view).toMatchObject({ config: { enabled: false }, credentials: [], status: { records: [] } })
    expect(ddnsViewSchema(view) instanceof Error).toBe(false)
    expect(view.providers.map(provider => provider.id)).toContain('cloudflare')
  })
})

describe('pUT /api/ddns', () => {
  it('saves the whole block and lists the configured targets as pending', async () => {
    const { app, store } = await makeApp()
    const response = await app.request('/api/ddns', put(configWithAccount))
    expect(response.status).toBe(200)

    const view = await body<DdnsBody>(response)
    expect(view.config.accounts).toHaveLength(1)
    expect(view.status.records).toEqual([
      expect.objectContaining({ host: 'home.example.com', type: 'A', state: 'pending' }),
    ])
    expect(store.config.ddns.enabled).toBe(true)
  })

  it('refuses a domain that points at an unknown account', async () => {
    const { app } = await makeApp()
    const response = await app.request('/api/ddns', put({ accounts: [], domains: [{ host: 'a.example.com', account: 'ghost' }] }))
    expect(response.status).toBe(400)
    expect((await body<DdnsBody>(response)).code).toBe('INVALID_DDNS')
  })

  it('refuses a record family the provider cannot manage', async () => {
    const { app } = await makeApp()
    const response = await app.request('/api/ddns', put({
      accounts: [{ id: 'nc', provider: 'namecheap' }],
      domains: [{ host: 'a.example.com', account: 'nc', types: ['AAAA'] }],
    }))
    expect(response.status).toBe(400)
    expect((await body<DdnsBody>(response)).message).toContain('cannot manage AAAA')
  })
})

describe('credentials', () => {
  it('stores them in the secrets file, never in the config', async () => {
    const { app, file, secretsFile, secrets } = await makeApp()
    await app.request('/api/ddns', put(configWithAccount))

    const response = await app.request('/api/ddns/credentials/cf', put({ credentials: { apiToken: 'super-secret' } }))
    expect(response.status).toBe(200)
    expect((await body<DdnsBody>(response)).credentials).toEqual(['cf'])
    expect(secrets.getDdnsCredentials('cf')).toEqual({ apiToken: 'super-secret' })

    expect(fs.readFileSync(secretsFile, 'utf8')).toContain('super-secret')
    expect(fs.readFileSync(file, 'utf8')).not.toContain('super-secret')
  })

  it('refuses credentials for an account that does not exist', async () => {
    const { app } = await makeApp()
    const response = await app.request('/api/ddns/credentials/ghost', put({ credentials: { apiToken: 'x' } }))
    expect(response.status).toBe(400)
    expect((await body<DdnsBody>(response)).code).toBe('UNKNOWN_DDNS_ACCOUNT')
  })

  it('refuses an incomplete credential set', async () => {
    const { app } = await makeApp()
    await app.request('/api/ddns', put(configWithAccount))
    const response = await app.request('/api/ddns/credentials/cf', put({ credentials: { email: 'a@b.c' } }))
    expect(response.status).toBe(400)
    expect((await body<DdnsBody>(response)).code).toBe('INVALID_DDNS_CREDENTIALS')
  })

  it('forgets them on delete', async () => {
    const { app, secrets } = await makeApp()
    await app.request('/api/ddns', put(configWithAccount))
    await app.request('/api/ddns/credentials/cf', put({ credentials: { apiToken: 'x' } }))

    const response = await app.request('/api/ddns/credentials/cf', { method: 'DELETE' })
    expect(response.status).toBe(200)
    expect((await body<DdnsBody>(response)).credentials).toEqual([])
    expect(secrets.getDdnsCredentials('cf')).toBeNull()
  })
})

describe('pOST /api/ddns/check', () => {
  it('runs a pass and reports each record', async () => {
    const { app } = await makeApp()
    await app.request('/api/ddns', put(configWithAccount))
    await app.request('/api/ddns/credentials/cf', put({ credentials: { apiToken: 'x' } }))

    const response = await app.request('/api/ddns/check', { method: 'POST' })
    expect(response.status).toBe(200)

    const view = await body<DdnsBody>(response)
    expect(view.status.records).toEqual([
      expect.objectContaining({ host: 'home.example.com', type: 'A', state: 'ok', ip: '203.0.113.7' }),
    ])
    expect(view.status.ipv4).toBe('203.0.113.7')
  })
})
