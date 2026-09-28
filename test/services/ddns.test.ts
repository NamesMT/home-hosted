import type { DdnsFetch } from '#src/providers/ddns/types'
import type { NotificationService } from '#src/services/notifications'
import type { DdnsConfig } from '#src/shared/contracts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type } from 'arktype'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DdnsService } from '#src/services/ddns'
import { ddnsConfigSchema } from '#src/shared/contracts'

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

async function harness(config: DdnsConfig, options: { credentials?: Record<string, Record<string, string>>, record?: string, fail?: boolean } = {}): Promise<Harness> {
  const dir = await tempDir()
  const statePath = path.join(dir, 'ddns.json')
  const calls: string[] = []
  const notify = vi.fn()
  let current = options.record ?? '198.51.100.1'

  const fetchImpl: DdnsFetch = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.includes('ipify.org'))
      return new Response('203.0.113.7')
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
    getCredentials: id => credentials[id] ?? null,
    notifications: { notify } as unknown as NotificationService,
    statePath,
    fetchImpl,
  })

  return { service, notify, calls, statePath }
}

/** ArkType's parsed output, with the error branch thrown away for the test. */
function ddnsConfig(input: unknown): DdnsConfig {
  const parsed = ddnsConfigSchema(input)
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return parsed
}

function baseConfig(overrides: Record<string, unknown> = {}): DdnsConfig {
  return ddnsConfig({
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
      expect.objectContaining({ host: 'home.example.com', type: 'A', state: 'ok', ip: '203.0.113.7' }),
    ])
    expect(status.ipv4).toBe('203.0.113.7')
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
    expect(saved.records['home.example.com|A']?.ip).toBe('203.0.113.7')
  })

  it('reports a provider failure and notifies once', async () => {
    const { service, notify } = await harness(baseConfig(), { fail: true })
    const status = await service.run()

    expect(status.records[0]?.state).toBe('error')
    expect(status.records[0]?.message).toContain('DNS validation error')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ serverId: 'ddns', reason: 'ddns-error' })
  })

  it('says nothing when notifications are off', async () => {
    const { service, notify } = await harness(baseConfig({ notify: false }), { fail: true })
    await service.run()
    expect(notify).not.toHaveBeenCalled()
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
})
