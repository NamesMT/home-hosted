import type { DdnsFetch, DdnsProvider, DdnsRecord } from '#src/providers/ddns/types'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { DDNS_PROVIDERS, ddnsProvider, validateDdnsConfig } from '#src/providers/ddns'
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
import { namecheapApiProvider, parseHosts } from '#src/providers/ddns/namecheap-api'
import { noipProvider } from '#src/providers/ddns/noip'
import { porkbunProvider } from '#src/providers/ddns/porkbun'
import { spaceshipProvider } from '#src/providers/ddns/spaceship'
import { splitHost } from '#src/providers/ddns/zone'
import { parseDdnsConfig } from '../support/capabilities'

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

/**
 * `update` is optional on the interface because a challenge-only provider has none.
 * Every provider these tests drive does, so this asserts it rather than scattering
 * non-null assertions through the file.
 */
function updater(provider: DdnsProvider): NonNullable<DdnsProvider['update']> {
  if (provider.update === undefined)
    throw new Error(`${provider.id} has no update`)
  return provider.update
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

    // The ranges the prefix checks missed. Each of these passes `isIP(value) === 6`, so the guard
    // is the only thing between them and a published AAAA record — and the function's own comment
    // says it returns "the first address that is really public".
    for (const ip of [
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      '::ffff:10.0.0.1', // IPv4-mapped private
      '::ffff:192.168.1.5', // IPv4-mapped private
      '::127.0.0.1', // IPv4-compatible loopback
      'ff02::1', // multicast
      'ff05::1:3', // multicast, site-local scope
      '2001:db8::1', // documentation
      '3fff::1', // documentation (RFC 9637)
      '64:ff9b::1.2.3.4', // IPv4/IPv6 translation
      '2002::1', // 6to4
      '2001::1', // Teredo
    ])
      expect(isPublicAddress(ip, 'AAAA'), ip).toBe(false)

    // And a plain global unicast address is still accepted, so the rule is not simply "refuse".
    expect(isPublicAddress('2a00:1450:4001:80e::200e', 'AAAA')).toBe(true)
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

    const result = await updater(cloudflareProvider)(record({ host: 'home.example.com' }), { credentials: { apiToken: 'tok' }, fetch })

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
    const result = await updater(cloudflareProvider)(record(), { credentials: { apiToken: 'tok' }, fetch })
    expect(result).toMatchObject({ ok: true, changed: false })
    // The ids are cached even though nothing was written, so a later change skips the lookups.
    expect(result.cache).toEqual({ zoneId: 'zone1', recordId: 'rec1' })
    expect(calls.some(call => call.init?.method === 'PATCH')).toBe(false)
  })

  it('surfaces the API error text', async () => {
    const { fetch } = recorder(() => json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, 403))
    const result = await updater(cloudflareProvider)(record(), { credentials: { apiToken: 'bad' }, fetch })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Authentication error')
  })

  it('needs a token or the legacy pair', () => {
    expect(cloudflareProvider.validate({ apiToken: 'x' })).toBeNull()
    expect(cloudflareProvider.validate({ email: 'a@b.c', apiKey: 'k' })).toBeNull()
    expect(cloudflareProvider.validate({})).toContain('apiToken')
  })

  it('writes a challenge TXT record without touching the rest of the zone', async () => {
    const { fetch, calls } = recorder((url, init) => {
      if (url.includes('/zones?name='))
        return url.includes('name=example.com') ? json({ success: true, result: [{ id: 'zone1', name: 'example.com' }] }) : json({ success: true, result: [] })
      if (url.includes('type=TXT'))
        return json({ success: true, result: [] })
      if (init?.method === 'POST')
        return json({ success: true, result: { id: 'txt1' } })
      return json({ success: true, result: [] })
    })

    const result = await cloudflareProvider.challenge!(
      { fqdn: '_acme-challenge.git.example.com', value: 'token-1', action: 'present' },
      { credentials: { apiToken: 'tok' }, fetch },
    )

    expect(result).toEqual({ ok: true, message: 'wrote the TXT record for _acme-challenge.git.example.com' })
    const write = calls.find(call => call.init?.method === 'POST')
    expect(write?.url).toBe('https://api.cloudflare.com/client/v4/zones/zone1/dns_records')
    expect(JSON.parse(String(write?.init?.body))).toEqual({ type: 'TXT', name: '_acme-challenge.git.example.com', content: 'token-1', ttl: 1 })
    // The list is the only read: a challenge must never rewrite other records.
    expect(calls.filter(call => call.init?.method === 'PATCH')).toEqual([])
  })

  it('does not add a second copy when the record already carries this value', async () => {
    const { fetch, calls } = recorder((url) => {
      if (url.includes('/zones?name='))
        return json({ success: true, result: [{ id: 'zone1', name: 'example.com' }] })
      return json({ success: true, result: [{ id: 'txt1', content: 'token-1' }] })
    })

    const result = await cloudflareProvider.challenge!(
      { fqdn: '_acme-challenge.git.example.com', value: 'token-1', action: 'present' },
      { credentials: { apiToken: 'tok' }, fetch },
    )

    expect(result.ok).toBe(true)
    expect(calls.some(call => call.init?.method === 'POST')).toBe(false)
  })

  it('writes its own value even when another TXT record sits at the same name', async () => {
    // A leftover from an earlier attempt is not a substitute: ACME validates the
    // value, so answering "already there" would fail the challenge forever.
    const { fetch, calls } = recorder((url, init) => {
      if (url.includes('/zones?name='))
        return json({ success: true, result: [{ id: 'zone1', name: 'example.com' }] })
      if (url.includes('type=TXT'))
        return json({ success: true, result: [{ id: 'stale', content: 'a-stale-different-value' }] })
      if (init?.method === 'POST')
        return json({ success: true, result: { id: 'txt2' } })
      return json({ success: true, result: [] })
    })

    const result = await cloudflareProvider.challenge!(
      { fqdn: '_acme-challenge.git.example.com', value: 'the-new-token', action: 'present' },
      { credentials: { apiToken: 'tok' }, fetch },
    )

    expect(result.ok).toBe(true)
    const write = calls.find(call => call.init?.method === 'POST')
    expect(write, 'the challenge value has to be written').toBeDefined()
    expect(JSON.parse(String(write?.init?.body))).toEqual({
      type: 'TXT',
      name: '_acme-challenge.git.example.com',
      content: 'the-new-token',
      ttl: 1,
    })
  })

  it('deletes only the records carrying its own value', async () => {
    const { fetch, calls } = recorder((url, init) => {
      if (url.includes('/zones?name='))
        return json({ success: true, result: [{ id: 'zone1', name: 'example.com' }] })
      if (url.includes('type=TXT'))
        return json({ success: true, result: [{ id: 'other', content: 'unrelated' }, { id: 'txt2', content: 'token-1' }] })
      if (init?.method === 'DELETE')
        return json({ success: true, result: {} })
      return json({ success: true, result: [] })
    })

    const result = await cloudflareProvider.challenge!(
      { fqdn: '_acme-challenge.git.example.com', value: 'token-1', action: 'cleanup' },
      { credentials: { apiToken: 'tok' }, fetch },
    )

    expect(result.ok).toBe(true)
    const deleted = calls.filter(call => call.init?.method === 'DELETE').map(call => call.url)
    // Another challenge for the same name, or somebody's own TXT, must survive.
    expect(deleted).toEqual([
      'https://api.cloudflare.com/client/v4/zones/zone1/dns_records/txt2',
    ])
  })

  it('treats an already-deleted challenge record as cleaned up', async () => {
    const { fetch } = recorder((url, init) => {
      if (url.includes('/zones?name='))
        return json({ success: true, result: [{ id: 'zone1', name: 'example.com' }] })
      if (url.includes('type=TXT'))
        return json({ success: true, result: [{ id: 'txt1', content: 'token-1' }] })
      if (init?.method === 'DELETE')
        return json({ success: false, errors: [{ code: 81044, message: 'Record not found' }] }, 404)
      return json({ success: true, result: [] })
    })

    const result = await cloudflareProvider.challenge!(
      { fqdn: '_acme-challenge.git.example.com', value: 'token-1', action: 'cleanup' },
      { credentials: { apiToken: 'tok' }, fetch },
    )

    expect(result.ok).toBe(true)
  })

  it('says so when the zone does not exist', async () => {
    const { fetch } = recorder(() => json({ success: true, result: [] }))
    const result = await cloudflareProvider.challenge!(
      { fqdn: '_acme-challenge.git.unknown.test', value: 'token-1', action: 'present' },
      { credentials: { apiToken: 'tok' }, fetch },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('does not have a zone')
  })
})

describe('namecheap', () => {
  it('sends one GET and trusts the XML, not the status code', async () => {
    const { fetch, calls } = recorder(() => text('<interface-response><IP>203.0.113.7</IP><ErrCount>0</ErrCount><Done>true</Done></interface-response>'))
    const result = await updater(namecheapProvider)(record({ host: 'home.example.com', type: 'A' }), { credentials: { password: 'pw' }, fetch })

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
    const result = await updater(namecheapProvider)(record(), { credentials: { password: 'pw' }, fetch })
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
    const result = await updater(porkbunProvider)(record({ ttl: 600 }), { credentials: { apikey: 'pk1', secretapikey: 'sk1' }, fetch })

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
    const result = await updater(spaceshipProvider)(record({ ttl: 3600 }), { credentials: { apiKey: 'k', apiSecret: 's' }, fetch })

    expect(result.ok).toBe(true)
    const put = calls.find(call => call.init?.method === 'PUT')
    expect(put?.url).toBe('https://spaceship.dev/api/v1/dns/records/example.com')
    expect(JSON.parse(String(put?.init?.body))).toEqual({ force: true, items: [{ type: 'A', name: 'home', ttl: 3600, address: '203.0.113.7' }] })
  })
})

describe('simple token providers', () => {
  it('no-ip sends basic auth and a recognised User-Agent', async () => {
    const { fetch, calls } = recorder(() => text('good 203.0.113.7'))
    const result = await updater(noipProvider)(record(), { credentials: { username: 'me@example.com', password: 'pw' }, fetch })
    expect(result.ok).toBe(true)
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('me@example.com:pw').toString('base64')}`)
    expect(headers['User-Agent']).toContain('home-hosted')
    expect(calls[0]?.url).toContain('myip=203.0.113.7')
  })

  it('no-ip uses myipv6 for AAAA', async () => {
    const { fetch, calls } = recorder(() => text('good 2606:4700::1111'))
    await updater(noipProvider)(record({ type: 'AAAA', ip: '2606:4700::1111' }), { credentials: { username: 'u', password: 'p' }, fetch })
    expect(calls[0]?.url).toContain('myipv6=2606%3A4700%3A%3A1111')
  })

  it('duckdns strips the zone from the subdomain', async () => {
    const { fetch, calls } = recorder(() => text('OK'))
    const result = await updater(duckdnsProvider)(record({ host: 'home.duckdns.org' }), { credentials: { token: 't' }, fetch })
    expect(result.ok).toBe(true)
    expect(calls[0]?.url).toContain('domains=home&token=t&ip=203.0.113.7')
  })

  it('duckdns reports KO', async () => {
    const { fetch } = recorder(() => text('KO'))
    expect((await updater(duckdnsProvider)(record(), { credentials: { token: 't' }, fetch })).ok).toBe(false)
  })

  it('dynu uses basic auth', async () => {
    const { fetch, calls } = recorder(() => text('nochg 203.0.113.7'))
    const result = await updater(dynuProvider)(record(), { credentials: { username: 'u', password: 'p' }, fetch })
    expect(result).toMatchObject({ ok: true, changed: false })
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toContain('Basic ')
  })

  it('desec binds the token to the hostname', async () => {
    const { fetch, calls } = recorder(() => text('good'))
    await updater(desecProvider)(record(), { credentials: { token: 'tok' }, fetch })
    expect(calls[0]?.url).toBe('https://update.dedyn.io/?hostname=home.example.com&myipv4=203.0.113.7')
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('home.example.com:tok').toString('base64')}`)
  })

  it('henet passes the per-host key', async () => {
    const { fetch, calls } = recorder(() => text('good 203.0.113.7'))
    await updater(henetProvider)(record(), { credentials: { key: 'k' }, fetch })
    expect(calls[0]?.url).toContain('password=k')
  })

  it('freedns accepts a whole Direct URL and reports its text errors', async () => {
    const ok = recorder(() => text('Updated home.example.com to 203.0.113.7'))
    const result = await updater(freednsProvider)(record(), { credentials: { token: 'https://freedns.afraid.org/dynamic/update.php?abc123' }, fetch: ok.fetch })
    expect(result.ok).toBe(true)
    expect(ok.calls[0]?.url).toBe('https://freedns.afraid.org/dynamic/update.php?abc123&address=203.0.113.7')

    const bad = recorder(() => text('ERROR: Invalid update URL (2)'))
    expect((await updater(freednsProvider)(record(), { credentials: { token: 'nope' }, fetch: bad.fetch })).ok).toBe(false)
  })
})

describe('rest providers', () => {
  it('gandi PUTs a one-value rrset with a PAT', async () => {
    const { fetch, calls } = recorder((_url, init) => (init?.method === 'PUT' ? json({ message: 'created' }, 201) : json({}, 404)))
    const result = await updater(gandiProvider)(record(), { credentials: { token: 'pat_x' }, fetch })
    expect(result.ok).toBe(true)
    const put = calls.find(call => call.init?.method === 'PUT')
    expect(put?.url).toBe('https://api.gandi.net/v5/livedns/domains/example.com/records/home/A')
    expect(JSON.parse(String(put?.init?.body))).toEqual({ rrset_values: ['203.0.113.7'], rrset_ttl: 300 })
    expect((put?.init?.headers as Record<string, string>).Authorization).toBe('Bearer pat_x')
  })

  it('godaddy PUTs an sso-key record', async () => {
    const { fetch, calls } = recorder((_url, init) => (init?.method === 'PUT' ? new Response(null, { status: 200 }) : json([{ data: '198.51.100.1', ttl: 600, name: 'home', type: 'A' }])))
    const result = await updater(godaddyProvider)(record(), { credentials: { key: 'k', secret: 's' }, fetch })
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
    const result = await updater(digitaloceanProvider)(record(), { credentials: { token: 'do' }, fetch })
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
    const config = parseDdnsConfig({
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

describe('namecheap through the XML API', () => {
  /** A reply carrying the records a `getHosts` call would return. */
  function hostsReply(records: Array<{ name: string, type: string, address: string, ttl?: string, mxPref?: string }>): string {
    const rows = records.map(record => `<Host HostId="1" Name="${record.name}" Type="${record.type}" Address="${record.address}" MXPref="${record.mxPref ?? '10'}" TTL="${record.ttl ?? '1800'}" />`).join('')
    return `<?xml version="1.0"?><ApiResponse Status="OK"><Errors /><CommandResponse><DomainDNSGetHostsResult Domain="example.com" IsUsingOurDNS="true">${rows}</DomainDNSGetHostsResult></CommandResponse></ApiResponse>`
  }

  const ok = '<?xml version="1.0"?><ApiResponse Status="OK"><Errors /><CommandResponse /></ApiResponse>'
  const bad = '<?xml version="1.0"?><ApiResponse Status="ERROR"><Errors><Error Number="1017105">Parameter ClientIP is disabled or locked</Error><Err1>ClientIP is not whitelisted</Err1></Errors></ApiResponse>'

  const credentials = { apiUser: 'me', apiKey: 'key', clientIp: '203.0.113.7' }

  /** The `setHosts` parameters, as the API would read them. */
  function writtenRecords(url: string): Array<{ name: string, type: string, address: string, ttl: string }> {
    const params = new URL(url).searchParams
    const records: Array<{ name: string, type: string, address: string, ttl: string }> = []
    for (let at = 1; params.has(`HostName${at}`); at++) {
      records.push({
        name: params.get(`HostName${at}`) ?? '',
        type: params.get(`RecordType${at}`) ?? '',
        address: params.get(`Address${at}`) ?? '',
        ttl: params.get(`TTL${at}`) ?? '',
      })
    }
    return records
  }

  it('adds the challenge record and writes every other record back', async () => {
    const existing = [
      { name: '@', type: 'A', address: '198.51.100.1', ttl: '1800' },
      { name: 'www', type: 'CNAME', address: 'example.com.', ttl: '1800' },
      { name: '@', type: 'MX', address: 'mail.example.com.', ttl: '1800', mxPref: '10' },
    ]
    const { fetch, calls } = recorder((url) => {
      const command = new URL(url).searchParams.get('Command')
      return command === 'namecheap.domains.dns.getHosts' ? text(hostsReply(existing)) : text(ok)
    })

    const result = await namecheapApiProvider.challenge!(
      { fqdn: '_acme-challenge.git.example.com', value: 'token-1', action: 'present' },
      { credentials, fetch },
    )

    expect(result.ok).toBe(true)
    const write = calls.find(call => call.url.includes('Command=namecheap.domains.dns.setHosts'))
    expect(write, 'the challenge should be written with setHosts').toBeDefined()
    const records = writtenRecords(write!.url)
    // Every record survives: setHosts replaces the set, so anything left out is deleted.
    expect(records).toEqual([
      { name: '@', type: 'A', address: '198.51.100.1', ttl: '1800' },
      { name: 'www', type: 'CNAME', address: 'example.com.', ttl: '1800' },
      { name: '@', type: 'MX', address: 'mail.example.com.', ttl: '1800' },
      { name: '_acme-challenge.git', type: 'TXT', address: 'token-1', ttl: '60' },
    ])
    // The MX preference is carried, or Namecheap resets it.
    expect(new URL(write!.url).searchParams.get('MXPref3')).toBe('10')
    const auth = new URL(write!.url).searchParams
    expect(auth.get('ApiUser')).toBe('me')
    expect(auth.get('ClientIp')).toBe('203.0.113.7')
    expect(auth.get('SLD')).toBe('example')
    expect(auth.get('TLD')).toBe('com')
  })

  it('does not write when the record already carries the value', async () => {
    const { fetch, calls } = recorder(() => text(hostsReply([
      { name: '_acme-challenge.git', type: 'TXT', address: 'token-1' },
    ])))

    const result = await namecheapApiProvider.challenge!(
      { fqdn: '_acme-challenge.git.example.com', value: 'token-1', action: 'present' },
      { credentials, fetch },
    )

    expect(result.ok).toBe(true)
    expect(calls.some(call => call.url.includes('Command=namecheap.domains.dns.setHosts'))).toBe(false)
  })

  it('removes only its own value on cleanup', async () => {
    const { fetch, calls } = recorder((url) => {
      const command = new URL(url).searchParams.get('Command')
      return command === 'namecheap.domains.dns.getHosts'
        ? text(hostsReply([
            { name: '@', type: 'A', address: '198.51.100.1' },
            { name: '_acme-challenge.git', type: 'TXT', address: 'token-1' },
            { name: '_acme-challenge.git', type: 'TXT', address: 'token-2' },
            { name: 'keep', type: 'TXT', address: 'not ours' },
          ]))
        : text(ok)
    })

    const result = await namecheapApiProvider.challenge!(
      { fqdn: '_acme-challenge.git.example.com', value: 'token-1', action: 'cleanup' },
      { credentials, fetch },
    )

    expect(result.ok).toBe(true)
    const records = writtenRecords(calls.find(call => call.url.includes('Command=namecheap.domains.dns.setHosts'))!.url)
    // A second challenge's value at the same name, and an unrelated TXT, both stay:
    // this call rewrites the whole zone, so anything left out is deleted for real.
    expect(records).toEqual([
      { name: '@', type: 'A', address: '198.51.100.1', ttl: '1800' },
      { name: '_acme-challenge.git', type: 'TXT', address: 'token-2', ttl: '1800' },
      { name: 'keep', type: 'TXT', address: 'not ours', ttl: '1800' },
    ])
  })

  it('reports a cleanup with nothing to remove without writing', async () => {
    const { fetch, calls } = recorder(() => text(hostsReply([{ name: '@', type: 'A', address: '198.51.100.1' }])))

    const result = await namecheapApiProvider.challenge!(
      { fqdn: '_acme-challenge.git.example.com', value: 'token-1', action: 'cleanup' },
      { credentials, fetch },
    )

    expect(result.ok).toBe(true)
    expect(calls.some(call => call.url.includes('Command=namecheap.domains.dns.setHosts'))).toBe(false)
  })

  it('refuses to add a record to a zone that is already full', async () => {
    const full = Array.from({ length: 150 }, (_, index) => ({ name: `h${index}`, type: 'A', address: '198.51.100.1' }))
    const { fetch, calls } = recorder(() => text(hostsReply(full)))

    const result = await namecheapApiProvider.challenge!(
      { fqdn: '_acme-challenge.git.example.com', value: 'token-1', action: 'present' },
      { credentials, fetch },
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('150')
    expect(calls.some(call => call.url.includes('Command=namecheap.domains.dns.setHosts'))).toBe(false)
  })

  it('surfaces what the API refused, including an unwhitelisted address', async () => {
    const { fetch } = recorder(() => text(bad))

    const result = await namecheapApiProvider.challenge!(
      { fqdn: '_acme-challenge.git.example.com', value: 'token-1', action: 'present' },
      { credentials, fetch },
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('ClientIP is not whitelisted')
  })

  it('needs the API user, the key and a whitelisted address', () => {
    expect(namecheapApiProvider.validate(credentials)).toBeNull()
    // The account name defaults to the API user, so only three fields are required.
    expect(namecheapApiProvider.validate({ apiUser: 'me', apiKey: 'key' })).toContain('clientIp')
    expect(namecheapApiProvider.validate({})).toContain('apiUser')
  })

  it('unescapes the values it read, so a rewrite does not corrupt them', () => {
    // The whole-zone rewrite writes back what it read: escaping left in would turn
    // `a&b` into `a&amp;b` on every challenge.
    const parsed = parseHosts(hostsReply([
      { name: 'txt', type: 'TXT', address: 'a&amp;b' },
      { name: 'redir', type: 'URL', address: 'https://x.test/?a=1&amp;b=2' },
    ]))
    expect(parsed.map(record => record.address)).toEqual(['a&b', 'https://x.test/?a=1&b=2'])
  })

  it('writes an unescaped value back when it rewrites the zone', async () => {
    const { fetch, calls } = recorder((url) => {
      const command = new URL(url).searchParams.get('Command')
      return command === 'namecheap.domains.dns.getHosts'
        ? text(hostsReply([{ name: 'txt', type: 'TXT', address: 'a&amp;b' }]))
        : text(ok)
    })

    const result = await namecheapApiProvider.challenge!(
      { fqdn: '_acme-challenge.git.example.com', value: 'token-1', action: 'present' },
      { credentials, fetch },
    )

    expect(result.ok).toBe(true)
    const write = new URL(calls.find(call => call.url.includes('Command=namecheap.domains.dns.setHosts'))!.url)
    // URLSearchParams decodes on read, so this is the literal string Namecheap stores.
    expect(write.searchParams.get('Address1')).toBe('a&b')
    expect(write.searchParams.get('Address2')).toBe('token-1')
  })

  it('reads the record attributes out of a getHosts reply', () => {
    expect(parseHosts(hostsReply([
      { name: '_acme-challenge', type: 'TXT', address: 'a value with spaces' },
      { name: '@', type: 'MX', address: 'mail.example.com.', mxPref: '20', ttl: '300' },
    ]))).toEqual([
      { name: '_acme-challenge', type: 'TXT', address: 'a value with spaces', mxPref: '10', ttl: '1800' },
      { name: '@', type: 'MX', address: 'mail.example.com.', mxPref: '20', ttl: '300' },
    ])
  })
})

/**
 * Every provider answers the same question: "can these credentials drive you?".
 *
 * `validate` is what the settings form and the config validator both call, and a provider whose
 * version says yes to nothing — or yes to everything — fails late: the account saves, and the DNS
 * update rejects it hours later, when a certificate is trying to renew. Only two of the fourteen
 * had it tested (cloudflare, namecheap-api), which is exactly how the other twelve would drift.
 *
 * The loop runs over the registry rather than a hand-written list, so a new provider is covered by
 * existing, not by remembering to add a case.
 */
describe('every ddns provider validates credentials', () => {
  it('refuses null and an empty object, naming what is missing', () => {
    for (const provider of DDNS_PROVIDERS) {
      for (const credentials of [null, {}]) {
        const verdict = provider.validate(credentials)
        expect(verdict, `${provider.id} must refuse ${JSON.stringify(credentials)}`).not.toBeNull()
      }
    }
  })

  it('refuses blank values, not just absent ones', () => {
    for (const provider of DDNS_PROVIDERS) {
      // A form leaves empty strings behind, so this is the shape a save actually carries. Both
      // spellings are checked separately: `''` is the untouched input, `' '` is one a person
      // typed a space into, and a provider that only trims for one of them lets the other through.
      for (const blank of ['', ' ']) {
        const blanks: Record<string, string> = {}
        for (const field of provider.fields)
          blanks[field.key] = blank
        expect(provider.validate(blanks), `${provider.id} must refuse ${JSON.stringify(blank)} fields`).not.toBeNull()
      }
    }
  })

  it('accepts a filled-in form and says nothing', () => {
    for (const provider of DDNS_PROVIDERS) {
      const filled: Record<string, string> = {}
      for (const field of provider.fields)
        filled[field.key] = `value-for-${field.key}`
      expect(provider.validate(filled), `${provider.id} must accept every field filled`).toBeNull()
    }
  })

  it('declares the metadata the form and the config validator read', () => {
    for (const provider of DDNS_PROVIDERS) {
      expect(provider.id, `${provider.id} needs an id`).toMatch(/^[a-z0-9-]+$/)
      expect(provider.label.length, `${provider.id} needs a label`).toBeGreaterThan(0)
      expect(provider.docsUrl, `${provider.id} should link its own docs`).toMatch(/^https:\/\//)
      expect(provider.fields.length, `${provider.id} needs at least one field`).toBeGreaterThan(0)
      expect(provider.families.length, `${provider.id} needs a record family`).toBeGreaterThan(0)
      // A duplicate key would make one field shadow another in the form.
      const keys = provider.fields.map(field => field.key)
      expect(new Set(keys).size, `${provider.id} has a duplicate field key`).toBe(keys.length)
    }
    // Anti-vacuity: the registry is the thing being covered, so it must not be empty.
    expect(DDNS_PROVIDERS.length).toBeGreaterThanOrEqual(14)
  })
})
