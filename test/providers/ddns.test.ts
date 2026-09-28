import type { DdnsFetch, DdnsRecord } from '#src/providers/ddns/types'
import type { DdnsConfig } from '#src/shared/contracts'
import { Buffer } from 'node:buffer'
import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { ddnsProvider, validateDdnsConfig } from '#src/providers/ddns'
import { cloudflareProvider } from '#src/providers/ddns/cloudflare'
import { desecProvider } from '#src/providers/ddns/desec'
import { digitaloceanProvider } from '#src/providers/ddns/digitalocean'
import { duckdnsProvider } from '#src/providers/ddns/duckdns'
import { describeDyndnsReply } from '#src/providers/ddns/dyndns2'
import { dynuProvider } from '#src/providers/ddns/dynu'
import { freednsProvider } from '#src/providers/ddns/freedns'
import { gandiProvider } from '#src/providers/ddns/gandi'
import { godaddyProvider } from '#src/providers/ddns/godaddy'
import { henetProvider } from '#src/providers/ddns/henet'
import { detectPublicAddress, isPublicAddress, parseAddressResponse } from '#src/providers/ddns/ip'
import { namecheapProvider } from '#src/providers/ddns/namecheap'
import { noipProvider } from '#src/providers/ddns/noip'
import { porkbunProvider } from '#src/providers/ddns/porkbun'
import { spaceshipProvider } from '#src/providers/ddns/spaceship'
import { splitHost } from '#src/providers/ddns/zone'
import { ddnsConfigSchema } from '#src/shared/contracts'

interface Call { url: string, init: RequestInit | undefined }

function recorder(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): { fetch: DdnsFetch, calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: DdnsFetch = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { fetch: fetchImpl, calls }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function text(body: string, status = 200): Response {
  return new Response(body, { status })
}

/** ArkType's parsed output, with the error branch thrown away for the test. */
function ddnsConfig(input: unknown): DdnsConfig {
  const parsed = ddnsConfigSchema(input)
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return parsed
}

function record(overrides: Partial<DdnsRecord> = {}): DdnsRecord {
  return { host: 'home.example.com', type: 'A', ip: '203.0.113.7', ttl: 300, proxied: false, ...overrides }
}

describe('zone splitting', () => {
  it('splits the apex and a subdomain', () => {
    expect(splitHost('home.example.com')).toEqual({ zone: 'example.com', name: 'home' })
    expect(splitHost('Example.COM.')).toEqual({ zone: 'example.com', name: '@' })
    expect(splitHost('a.b.example.com')).toEqual({ zone: 'example.com', name: 'a.b' })
  })

  it('knows the common multi-label suffixes', () => {
    expect(splitHost('home.example.co.uk')).toEqual({ zone: 'example.co.uk', name: 'home' })
    expect(splitHost('api.example.com.au')).toEqual({ zone: 'example.com.au', name: 'api' })
  })

  it('honours an explicit zone', () => {
    expect(splitHost('home.example.co.uk', 'home.example.co.uk')).toEqual({ zone: 'home.example.co.uk', name: '@' })
  })
})

describe('public IP detection', () => {
  it('reads a bare address, a trace body and JSON', () => {
    expect(parseAddressResponse('203.0.113.7\n', 'A')).toBe('203.0.113.7')
    expect(parseAddressResponse('fl=1\nip=203.0.113.8\nts=1\n', 'A')).toBe('203.0.113.8')
    expect(parseAddressResponse('{"ip":"203.0.113.9"}', 'A')).toBe('203.0.113.9')
    expect(parseAddressResponse('{"address":"2606:4700::1111"}', 'AAAA')).toBe('2606:4700::1111')
  })

  it('refuses an address of the wrong family and a private one', () => {
    expect(parseAddressResponse('203.0.113.7', 'AAAA')).toBeNull()
    expect(parseAddressResponse('192.168.1.10', 'A')).toBeNull()
    expect(parseAddressResponse('100.64.0.1', 'A')).toBeNull()
    expect(isPublicAddress('10.0.0.1', 'A')).toBe(false)
    expect(isPublicAddress('fe80::1', 'AAAA')).toBe(false)
    expect(isPublicAddress('fd00::1', 'AAAA')).toBe(false)
    expect(isPublicAddress('2606:4700::1111', 'AAAA')).toBe(true)
  })

  it('falls back through the endpoint list', async () => {
    const { fetch, calls } = recorder((url) => {
      if (url.includes('api4.ipify.org'))
        return json({}, 503)
      return text('203.0.113.7')
    })
    const result = await detectPublicAddress('A', '', fetch)
    expect(result).toEqual({ ip: '203.0.113.7', error: null })
    expect(calls).toHaveLength(2)
  })

  it('uses only the configured endpoint when one is set', async () => {
    const { fetch, calls } = recorder(() => text('203.0.113.9'))
    const result = await detectPublicAddress('A', 'https://example.test/ip', fetch)
    expect(result.ip).toBe('203.0.113.9')
    expect(calls.map(call => call.url)).toEqual(['https://example.test/ip'])
  })
})

describe('dyndns2 replies', () => {
  it('separates the code from the detail', () => {
    expect(describeDyndnsReply('good 203.0.113.7', 'no-ip')).toMatchObject({ ok: true, changed: true })
    expect(describeDyndnsReply('nochg 203.0.113.7', 'no-ip')).toMatchObject({ ok: true, changed: false })
    expect(describeDyndnsReply('badauth', 'no-ip')).toMatchObject({ ok: false })
    expect(describeDyndnsReply('911', 'no-ip').error).toContain('30 minutes')
    expect(describeDyndnsReply('weird', 'no-ip').ok).toBe(false)
  })
})

describe('cloudflare', () => {
  it('walks the zone parents, then patches the record it found', async () => {
    const { fetch, calls } = recorder((url, init) => {
      if (url.includes('/zones?name='))
        return url.includes('name=example.com') ? json({ success: true, result: [{ id: 'zone1', name: 'example.com' }] }) : json({ success: true, result: [] })
      if (init?.method === 'PATCH')
        return json({ success: true, result: { id: 'rec1' } })
      return json({ success: true, result: [{ id: 'rec1', content: '198.51.100.1', ttl: 1, proxied: false }] })
    })

    const result = await cloudflareProvider.update(record({ host: 'home.example.com' }), { credentials: { apiToken: 'tok' }, fetch })

    expect(result).toMatchObject({ ok: true, changed: true })
    expect(result.cache).toEqual({ zoneId: 'zone1', recordId: 'rec1' })
    const patch = calls.find(call => call.init?.method === 'PATCH')
    expect(patch?.url).toBe('https://api.cloudflare.com/client/v4/zones/zone1/dns_records/rec1')
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ type: 'A', name: 'home.example.com', content: '203.0.113.7', ttl: 300, proxied: false })
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('reports an already-current record without writing', async () => {
    const { fetch, calls } = recorder((url) => {
      if (url.includes('/zones?name='))
        return json({ success: true, result: [{ id: 'zone1', name: 'example.com' }] })
      return json({ success: true, result: [{ id: 'rec1', content: '203.0.113.7', ttl: 300, proxied: false }] })
    })
    const result = await cloudflareProvider.update(record(), { credentials: { apiToken: 'tok' }, fetch })
    expect(result).toMatchObject({ ok: true, changed: false })
    // The ids are cached even though nothing was written, so a later change skips the lookups.
    expect(result.cache).toEqual({ zoneId: 'zone1', recordId: 'rec1' })
    expect(calls.some(call => call.init?.method === 'PATCH')).toBe(false)
  })

  it('surfaces the API error text', async () => {
    const { fetch } = recorder(() => json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, 403))
    const result = await cloudflareProvider.update(record(), { credentials: { apiToken: 'bad' }, fetch })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Authentication error')
  })

  it('needs a token or the legacy pair', () => {
    expect(cloudflareProvider.validate({ apiToken: 'x' })).toBeNull()
    expect(cloudflareProvider.validate({ email: 'a@b.c', apiKey: 'k' })).toBeNull()
    expect(cloudflareProvider.validate({})).toContain('apiToken')
  })
})

describe('namecheap', () => {
  it('sends one GET and trusts the XML, not the status code', async () => {
    const { fetch, calls } = recorder(() => text('<interface-response><IP>203.0.113.7</IP><ErrCount>0</ErrCount><Done>true</Done></interface-response>'))
    const result = await namecheapProvider.update(record({ host: 'home.example.com', type: 'A' }), { credentials: { password: 'pw' }, fetch })

    expect(result.ok).toBe(true)
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/update')
    expect(url.searchParams.get('host')).toBe('home')
    expect(url.searchParams.get('domain')).toBe('example.com')
    expect(url.searchParams.get('password')).toBe('pw')
    expect(url.searchParams.get('ip')).toBe('203.0.113.7')
  })

  it('reports the provider error from ErrCount', async () => {
    const { fetch } = recorder(() => text('<interface-response><ErrCount>1</ErrCount><errors><Err1>No Records updated. A record not Found;</Err1></errors></interface-response>'))
    const result = await namecheapProvider.update(record(), { credentials: { password: 'pw' }, fetch })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('A record not Found')
  })

  it('only manages A records', () => {
    expect(namecheapProvider.families).toEqual(['A'])
  })
})

describe('porkbun', () => {
  it('diffs by name+type and upserts', async () => {
    const seen: string[] = []
    const { fetch, calls } = recorder((url) => {
      seen.push(url)
      if (url.includes('retrieveByNameType'))
        return json({ status: 'SUCCESS', records: [{ id: '1', name: 'home.example.com', type: 'A', content: '198.51.100.1', ttl: '600' }] })
      return json({ status: 'SUCCESS' })
    })
    const result = await porkbunProvider.update(record({ ttl: 600 }), { credentials: { apikey: 'pk1', secretapikey: 'sk1' }, fetch })

    expect(result).toMatchObject({ ok: true, changed: true })
    const edit = calls.find(call => call.url.includes('editByNameType'))
    expect(edit?.url).toContain('/dns/editByNameType/example.com/A/home')
    expect(JSON.parse(String(edit?.init?.body))).toEqual({ content: '203.0.113.7', ttl: 600 })
    expect((edit?.init?.headers as Record<string, string>)['X-API-Key']).toBe('pk1')
    expect(seen).toHaveLength(2)
  })
})

describe('spaceship', () => {
  it('reads the record set before upserting', async () => {
    const { fetch, calls } = recorder((url, init) => {
      if (init?.method === 'PUT')
        return new Response(null, { status: 204 })
      return json({ items: [{ type: 'A', name: 'home', ttl: 3600, address: '198.51.100.1' }] })
    })
    const result = await spaceshipProvider.update(record({ ttl: 3600 }), { credentials: { apiKey: 'k', apiSecret: 's' }, fetch })

    expect(result.ok).toBe(true)
    const put = calls.find(call => call.init?.method === 'PUT')
    expect(put?.url).toBe('https://spaceship.dev/api/v1/dns/records/example.com')
    expect(JSON.parse(String(put?.init?.body))).toEqual({ force: true, items: [{ type: 'A', name: 'home', ttl: 3600, address: '203.0.113.7' }] })
  })
})

describe('simple token providers', () => {
  it('no-ip sends basic auth and a recognised User-Agent', async () => {
    const { fetch, calls } = recorder(() => text('good 203.0.113.7'))
    const result = await noipProvider.update(record(), { credentials: { username: 'me@example.com', password: 'pw' }, fetch })
    expect(result.ok).toBe(true)
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('me@example.com:pw').toString('base64')}`)
    expect(headers['User-Agent']).toContain('home-hosted')
    expect(calls[0]?.url).toContain('myip=203.0.113.7')
  })

  it('no-ip uses myipv6 for AAAA', async () => {
    const { fetch, calls } = recorder(() => text('good 2606:4700::1111'))
    await noipProvider.update(record({ type: 'AAAA', ip: '2606:4700::1111' }), { credentials: { username: 'u', password: 'p' }, fetch })
    expect(calls[0]?.url).toContain('myipv6=2606%3A4700%3A%3A1111')
  })

  it('duckdns strips the zone from the subdomain', async () => {
    const { fetch, calls } = recorder(() => text('OK'))
    const result = await duckdnsProvider.update(record({ host: 'home.duckdns.org' }), { credentials: { token: 't' }, fetch })
    expect(result.ok).toBe(true)
    expect(calls[0]?.url).toContain('domains=home&token=t&ip=203.0.113.7')
  })

  it('duckdns reports KO', async () => {
    const { fetch } = recorder(() => text('KO'))
    expect((await duckdnsProvider.update(record(), { credentials: { token: 't' }, fetch })).ok).toBe(false)
  })

  it('dynu uses basic auth', async () => {
    const { fetch, calls } = recorder(() => text('nochg 203.0.113.7'))
    const result = await dynuProvider.update(record(), { credentials: { username: 'u', password: 'p' }, fetch })
    expect(result).toMatchObject({ ok: true, changed: false })
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toContain('Basic ')
  })

  it('desec binds the token to the hostname', async () => {
    const { fetch, calls } = recorder(() => text('good'))
    await desecProvider.update(record(), { credentials: { token: 'tok' }, fetch })
    expect(calls[0]?.url).toBe('https://update.dedyn.io/?hostname=home.example.com&myipv4=203.0.113.7')
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('home.example.com:tok').toString('base64')}`)
  })

  it('henet passes the per-host key', async () => {
    const { fetch, calls } = recorder(() => text('good 203.0.113.7'))
    await henetProvider.update(record(), { credentials: { key: 'k' }, fetch })
    expect(calls[0]?.url).toContain('password=k')
  })

  it('freedns accepts a whole Direct URL and reports its text errors', async () => {
    const ok = recorder(() => text('Updated home.example.com to 203.0.113.7'))
    const result = await freednsProvider.update(record(), { credentials: { token: 'https://freedns.afraid.org/dynamic/update.php?abc123' }, fetch: ok.fetch })
    expect(result.ok).toBe(true)
    expect(ok.calls[0]?.url).toBe('https://freedns.afraid.org/dynamic/update.php?abc123&address=203.0.113.7')

    const bad = recorder(() => text('ERROR: Invalid update URL (2)'))
    expect((await freednsProvider.update(record(), { credentials: { token: 'nope' }, fetch: bad.fetch })).ok).toBe(false)
  })
})

describe('rest providers', () => {
  it('gandi PUTs a one-value rrset with a PAT', async () => {
    const { fetch, calls } = recorder((_url, init) => (init?.method === 'PUT' ? json({ message: 'created' }, 201) : json({}, 404)))
    const result = await gandiProvider.update(record(), { credentials: { token: 'pat_x' }, fetch })
    expect(result.ok).toBe(true)
    const put = calls.find(call => call.init?.method === 'PUT')
    expect(put?.url).toBe('https://api.gandi.net/v5/livedns/domains/example.com/records/home/A')
    expect(JSON.parse(String(put?.init?.body))).toEqual({ rrset_values: ['203.0.113.7'], rrset_ttl: 300 })
    expect((put?.init?.headers as Record<string, string>).Authorization).toBe('Bearer pat_x')
  })

  it('godaddy PUTs an sso-key record', async () => {
    const { fetch, calls } = recorder((_url, init) => (init?.method === 'PUT' ? new Response(null, { status: 200 }) : json([{ data: '198.51.100.1', ttl: 600, name: 'home', type: 'A' }])))
    const result = await godaddyProvider.update(record(), { credentials: { key: 'k', secret: 's' }, fetch })
    expect(result.ok).toBe(true)
    const put = calls.find(call => call.init?.method === 'PUT')
    expect(put?.url).toBe('https://api.godaddy.com/v1/domains/example.com/records/A/home')
    expect((put?.init?.headers as Record<string, string>).Authorization).toBe('sso-key k:s')
  })

  it('digitalocean updates the record it found by name', async () => {
    const { fetch, calls } = recorder((_url, init) => {
      if (init?.method === 'PUT')
        return json({ domain_record: {} })
      return json({ domain_records: [{ id: 7, name: 'home', type: 'A', data: '198.51.100.1', ttl: 1800 }] })
    })
    const result = await digitaloceanProvider.update(record(), { credentials: { token: 'do' }, fetch })
    expect(result.ok).toBe(true)
    expect(calls.find(call => call.init?.method === 'PUT')?.url).toBe('https://api.digitalocean.com/v2/domains/example.com/records/7')
  })
})

describe('provider registry', () => {
  it('knows every provider the settings page offers', () => {
    for (const id of ['cloudflare', 'namecheap', 'spaceship', 'porkbun', 'godaddy', 'gandi', 'digitalocean', 'desec', 'duckdns', 'noip', 'dynu', 'henet', 'freedns'])
      expect(ddnsProvider(id)).not.toBeNull()
    expect(ddnsProvider('nope')).toBeNull()
  })

  it('validates accounts, providers and record families', () => {
    const config = ddnsConfig({
      accounts: [
        { id: 'cf', provider: 'cloudflare' },
        { id: 'cf', provider: 'cloudflare' },
        { id: 'nc', provider: 'namecheap' },
        { id: 'bad', provider: 'nope' },
      ],
      domains: [
        { host: 'a.example.com', account: 'cf', types: ['A', 'AAAA'] },
        { host: 'a.example.com', account: 'cf', types: ['A'] },
        { host: 'b.example.com', account: 'nc', types: ['AAAA'] },
        { host: 'c.example.com', account: 'ghost' },
      ],
    })
    const errors = validateDdnsConfig(config)
    expect(errors.some(error => error.includes('declared twice'))).toBe(true)
    expect(errors.some(error => error.includes('unknown provider'))).toBe(true)
    expect(errors.some(error => error.includes('cannot manage AAAA'))).toBe(true)
    expect(errors.some(error => error.includes('asks for A twice'))).toBe(true)
    expect(errors.some(error => error.includes('unknown account'))).toBe(true)
  })
})
