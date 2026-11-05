import type { DdnsFetch } from '#src/providers/ddns/types'
import type { NotificationService } from '#src/services/notifications'
import type { DdnsConfig } from '#src/shared/contracts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DdnsService } from '#src/services/ddns'
import { parseDdnsConfig } from '../support/capabilities'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0))
    await fs.promises.rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-ddns-'))
  dirs.push(dir)
  return dir
}

interface Harness {
  service: DdnsService
  notify: ReturnType<typeof vi.fn>
  calls: string[]
  statePath: string
}

async function harness(config: DdnsConfig, options: { credentials?: Record<string, Record<string, string>>, record?: string, fail?: boolean, state?: unknown } = {}): Promise<Harness> {
  const dir = await tempDir()
  const statePath = path.join(dir, 'ddns.json')
  if (options.state !== undefined)
    fs.writeFileSync(statePath, JSON.stringify(options.state))
  const calls: string[] = []
  const notify = vi.fn()
  let current = options.record ?? '198.51.100.1'

  const fetchImpl: DdnsFetch = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.includes('ipify.org'))
      return new Response('93.184.216.7')
    if (url.includes('/zones?name='))
      return new Response(JSON.stringify({ success: true, result: [{ id: 'zone1', name: 'example.com' }] }), { status: 200 })
    if (init?.method === 'PATCH') {
      if (options.fail === true)
        return new Response(JSON.stringify({ success: false, errors: [{ code: 1004, message: 'DNS validation error' }] }), { status: 400 })
      current = (JSON.parse(String(init.body)) as { content: string }).content
      return new Response(JSON.stringify({ success: true, result: { id: 'rec1' } }), { status: 200 })
    }
    return new Response(JSON.stringify({ success: true, result: [{ id: 'rec1', content: current, ttl: 300, proxied: false }] }), { status: 200 })
  }

  const credentials = options.credentials ?? { cf: { apiToken: 'tok' } }
  const service = new DdnsService({
    getConfig: () => config,
    getCredentials: (id: string) => credentials[id] ?? null,
    notifications: { notify } as unknown as NotificationService,
    statePath,
    fetchImpl,
  })

  return { service, notify, calls, statePath }
}

/** ArkType's parsed output, with the error branch thrown away for the test. */

function baseConfig(overrides: Record<string, unknown> = {}): DdnsConfig {
  return parseDdnsConfig({
    enabled: true,
    intervalMs: 60000,
    accounts: [{ id: 'cf', provider: 'cloudflare' }],
    domains: [{ host: 'home.example.com', account: 'cf', types: ['A'] }],
    ...overrides,
  })
}

const providerCalls = (calls: string[]): string[] => calls.filter(call => call.includes('api.cloudflare.com'))

describe('ddnsService', () => {
  it('detects the address, updates the record and records the result', async () => {
    const { service } = await harness(baseConfig())
    const status = await service.run()

    expect(status.records).toEqual([
      expect.objectContaining({ host: 'home.example.com', type: 'A', state: 'ok', ip: '93.184.216.7' }),
    ])
    expect(status.ipv4).toBe('93.184.216.7')
    expect(status.lastResult).toContain('1 updated')
  })

  it('skips the provider entirely while the address is unchanged', async () => {
    const { service, calls } = await harness(baseConfig())
    await service.run()
    const afterFirst = providerCalls(calls).length

    const second = await service.run()
    expect(second.records[0]?.state).toBe('unchanged')
    expect(providerCalls(calls).length).toBe(afterFirst)
  })

  it('re-sends when asked to force a pass', async () => {
    const { service, calls } = await harness(baseConfig())
    await service.run()
    const afterFirst = providerCalls(calls).length

    await service.run({ force: true })
    expect(providerCalls(calls).length).toBeGreaterThan(afterFirst)
  })

  it('remembers what it confirmed on disk', async () => {
    const { service, statePath } = await harness(baseConfig())
    await service.run()

    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { records: Record<string, { ip: string }> }
    expect(saved.records['home.example.com|A|cf|cloudflare']?.ip).toBe('93.184.216.7')
  })

  it('reports a provider failure and notifies once', async () => {
    const { service, notify } = await harness(baseConfig(), { fail: true })
    const status = await service.run()

    expect(status.records[0]?.state).toBe('error')
    expect(status.records[0]?.message).toContain('DNS validation error')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ serverId: 'ddns', reason: 'ddns-error' })
    // Whether Telegram carries it is the notification policy's call, not this one.
  })

  it('stays quiet on a pass that changed nothing', async () => {
    const { service, notify } = await harness(baseConfig())
    await service.run()
    await service.run()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('skips a family whose detection is switched off', async () => {
    const { service, calls } = await harness(baseConfig({ domains: [{ host: 'home.example.com', account: 'cf', types: ['A', 'AAAA'] }] }))
    const status = await service.run()

    expect(status.records).toEqual([
      expect.objectContaining({ type: 'A', state: 'ok' }),
      expect.objectContaining({ type: 'AAAA', state: 'skipped' }),
    ])
    expect(status.records[1]?.message).toContain('detection')
    expect(calls.some(call => call.includes('api6.ipify.org'))).toBe(false)
  })

  it('skips a record the provider cannot manage, and names an unknown account', async () => {
    const { service } = await harness(baseConfig({ domains: [{ host: 'legacy.example.com', account: 'ghost', types: ['A'] }] }))
    const status = await service.run()
    expect(status.records[0]?.state).toBe('skipped')
    expect(status.records[0]?.message).toContain('unknown account')
  })

  it('lists configured targets before the first pass', () => {
    const config = baseConfig()
    const service = new DdnsService({
      getConfig: () => config,
      getCredentials: () => null,
      notifications: { notify: vi.fn() } as unknown as NotificationService,
      statePath: path.join(os.tmpdir(), 'hh-ddns-unused.json'),
    })
    expect(service.view.records).toEqual([expect.objectContaining({ host: 'home.example.com', state: 'pending', ip: null })])
  })

  it('throttles ticks by the interval and ignores a disabled block', async () => {
    const config = baseConfig()
    const { service, calls } = await harness(config)
    service.tick(1000)
    await vi.waitFor(() => expect(providerCalls(calls).length).toBe(3))

    const afterFirst = calls.length
    // Still inside the interval, so nothing new is even detected.
    service.tick(2000)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(calls.length).toBe(afterFirst)

    // `refresh` clears the window, which is what an API save does.
    service.refresh()
    service.tick(2000)
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(afterFirst))

    const disabled = await harness(baseConfig({ enabled: false }))
    disabled.service.tick(1000)
    expect(disabled.calls).toHaveLength(0)
  })

  it('skips an account whose provider only answers challenges', async () => {
    // `namecheap-api` exists for DNS-01 and has no address update, so a hostname
    // pointed at it must say so rather than fail obscurely.
    const { service, calls } = await harness(baseConfig({
      accounts: [{ id: 'nc', provider: 'namecheap-api' }],
      domains: [{ host: 'home.example.com', account: 'nc', types: ['A'] }],
    }), { credentials: { nc: { apiUser: 'me', apiKey: 'k', clientIp: '93.184.216.7' } } })

    const status = await service.run()

    expect(status.records[0]).toMatchObject({ state: 'skipped' })
    expect(status.records[0]?.message).toContain('does not update addresses')
    expect(calls.some(call => call.includes('api.namecheap.com'))).toBe(false)
  })

  it('reads a cache entry keyed the old way as a miss, not a crash', async () => {
    const state = { version: 1, updatedAt: 1, records: { 'home.example.com|A': { ip: '93.184.216.7', updatedAt: 1 } } }
    const { service, calls } = await harness(baseConfig(), { state })

    const status = await service.run()
    expect(status.records[0]?.state).toBe('ok')
    expect(providerCalls(calls).length).toBeGreaterThan(0)
  })

  it('re-sends a hostname moved to another account, and after its account\'s credentials change', async () => {
    const config = baseConfig({ accounts: [{ id: 'cf', provider: 'cloudflare' }, { id: 'cf2', provider: 'cloudflare' }] })
    const { service, calls } = await harness(config, { credentials: { cf: { apiToken: 'a' }, cf2: { apiToken: 'b' } } })
    await service.run()
    let before = providerCalls(calls).length

    // Same host and type, another account: what `cf` confirmed says nothing about `cf2`.
    config.domains[0]!.account = 'cf2'
    expect((await service.run()).records[0]?.state).toBe('ok')
    expect(providerCalls(calls).length).toBeGreaterThan(before)

    before = providerCalls(calls).length
    service.refresh({ account: 'cf2' })
    await service.run()
    expect(providerCalls(calls).length, 'new credentials may reach another provider account').toBeGreaterThan(before)
  })
})

describe('a permanent provider refusal', () => {
  async function noip(reply: string): Promise<{ service: DdnsService, updates: () => number, config: DdnsConfig, credentials: Record<string, Record<string, string>> }> {
    const dir = await tempDir()
    let updates = 0
    const config = baseConfig({ accounts: [{ id: 'ip', provider: 'noip' }], domains: [{ host: 'home.example.com', account: 'ip', types: ['A'] }] })
    const credentials: Record<string, Record<string, string>> = { ip: { username: 'me', password: 'wrong' } }
    const service = new DdnsService({
      getConfig: () => config,
      getCredentials: id => credentials[id] ?? null,
      notifications: { notify: vi.fn() } as unknown as NotificationService,
      statePath: path.join(dir, 'ddns.json'),
      fetchImpl: async (url) => {
        if (url.includes('ipify.org'))
          return new Response('93.184.216.7')
        updates += 1
        return new Response(reply)
      },
    })
    return { service, updates: () => updates, config, credentials }
  }

  it('stops retrying badauth until the credentials change or a check is asked for', async () => {
    const { service, updates, credentials } = await noip('badauth')
    expect((await service.run()).records[0]).toMatchObject({ state: 'error' })
    expect(updates()).toBe(1)

    const again = await service.run()
    expect(updates(), 'the same credentials get the same refusal').toBe(1)
    expect(again.records[0]).toMatchObject({ state: 'error', stopped: true })
    expect(again.records[0]?.message).toContain('rejected the credentials')

    credentials.ip = { username: 'me', password: 'right' }
    await service.run()
    expect(updates(), 'new credentials are worth one more try').toBe(2)

    await service.run({ force: true })
    expect(updates(), 'an explicit check always asks').toBe(3)

    service.refresh()
    await service.run()
    expect(updates(), 'a save lifts the stop').toBe(4)
  })

  it('keeps retrying a transient refusal', async () => {
    const { service, updates } = await noip('911')
    await service.run()
    const second = await service.run()
    expect(updates()).toBe(2)
    expect(second.records[0]?.stopped).toBeUndefined()
  })
})
