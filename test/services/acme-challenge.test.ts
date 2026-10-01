import type { DdnsFetch } from '#src/providers/ddns/types'
import type { ChallengeAccount } from '#src/services/acme-challenge'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { AcmeChallengeService } from '#src/services/acme-challenge'

const ACCOUNT: ChallengeAccount = {
  workspaceId: 'default',
  accountId: 'cf',
  provider: 'cloudflare',
  credentials: { apiToken: 'tok' },
}

interface ChallengeOutcome {
  fqdn: string
  action: string
  ok: boolean
  message: string
  account: ChallengeAccount | null
}

interface Call { url: string, init: RequestInit | undefined }

/** A Cloudflare that answers the zone walk, the TXT list and the writes. */
function cloudflare(overrides: { existing?: boolean } = {}): { fetch: DdnsFetch, calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: DdnsFetch = async (url, init) => {
    calls.push({ url, init })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.includes('/zones?name='))
      return url.includes('name=example.com') ? json({ success: true, result: [{ id: 'zone1', name: 'example.com' }] }) : json({ success: true, result: [] })
    if (url.includes('type=TXT'))
      return json({ success: true, result: overrides.existing === true ? [{ id: 'rec1', content: 'token-1' }] : [] })
    if (init?.method === 'DELETE')
      return json({ success: true, result: {} })
    return json({ success: true, result: { id: 'rec2' } })
  }
  return { fetch: fetchImpl, calls }
}

function request(body: unknown, auth?: string): Request {
  return new Request('http://127.0.0.1:3999/_acme/present', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth === undefined ? {} : { authorization: auth }),
    },
    body: JSON.stringify(body),
  })
}

const basic = (user: string, password: string): string => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

function service(input: {
  auth?: { username: string, password: string } | null
  account?: ChallengeAccount | null
  fetch?: DdnsFetch
  onResult?: (result: ChallengeOutcome) => void
} = {}) {
  const auth = input.auth === undefined ? { username: 'panel', password: 'secret' } : input.auth
  return new AcmeChallengeService({
    // Read per request, the way the panel does it.
    auth: () => auth,
    accountFor: () => (input.account === undefined ? ACCOUNT : input.account),
    fetchImpl: input.fetch,
    onResult: input.onResult,
  })
}

describe('the ACME challenge endpoint', () => {
  it('writes the TXT record the engine asked for, and echoes it back', async () => {
    const { fetch, calls } = cloudflare()
    const response = await service({ fetch }).handle(
      request({ fqdn: '_acme-challenge.git.example.com.', value: 'token-1' }, basic('panel', 'secret')),
      'present',
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ fqdn: '_acme-challenge.git.example.com.', value: 'token-1' })
    const write = calls.find(call => call.init?.method === 'POST' && call.url.endsWith('/dns_records'))
    expect(write?.url).toBe('https://api.cloudflare.com/client/v4/zones/zone1/dns_records')
    expect(JSON.parse(String(write?.init?.body))).toEqual({
      type: 'TXT',
      name: '_acme-challenge.git.example.com',
      content: 'token-1',
      ttl: 1,
    })
  })

  it('deletes the record on cleanup', async () => {
    const { fetch, calls } = cloudflare({ existing: true })
    const response = await service({ fetch }).handle(
      request({ fqdn: '_acme-challenge.git.example.com.', value: 'token-1' }, basic('panel', 'secret')),
      'cleanup',
    )

    expect(response.status).toBe(200)
    expect(calls.some(call => call.init?.method === 'DELETE' && call.url.includes('/dns_records/rec1'))).toBe(true)
  })

  it('refuses a caller that cannot authenticate', async () => {
    const { fetch, calls } = cloudflare()
    const anonymous = await service({ fetch }).handle(request({ fqdn: '_acme-challenge.git.example.com.', value: 'token-1' }), 'present')
    expect(anonymous.status).toBe(401)

    const wrong = await service({ fetch }).handle(
      request({ fqdn: '_acme-challenge.git.example.com.', value: 'token-1' }, basic('panel', 'nope')),
      'present',
    )
    expect(wrong.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('does not write for a name no route claims', async () => {
    const { fetch, calls } = cloudflare()
    const response = await service({ fetch, account: null }).handle(
      request({ fqdn: '_acme-challenge.other.example.net.', value: 'token-1' }, basic('panel', 'secret')),
      'present',
    )

    expect(response.status).toBe(404)
    expect(calls).toEqual([])
  })

  it('reports an account whose credentials cannot write TXT', async () => {
    const { fetch, calls } = cloudflare()
    const response = await service({ fetch, account: { ...ACCOUNT, provider: 'duckdns' } }).handle(
      request({ fqdn: '_acme-challenge.git.example.com.', value: 'token-1' }, basic('panel', 'secret')),
      'present',
    )

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('cannot write TXT')
    expect(calls).toEqual([])
  })

  it('rejects a body that is not the two-field message', async () => {
    const response = await service().handle(request({ fqdn: '_acme-challenge.git.example.com.' }, basic('panel', 'secret')), 'present')
    expect(response.status).toBe(400)

    const notJson = await service().handle(
      new Request('http://127.0.0.1:3999/_acme/present', { method: 'POST', headers: { authorization: basic('panel', 'secret') }, body: 'nope' }),
      'present',
    )
    expect(notJson.status).toBe(400)
  })

  it('serves only the two actions the protocol defines', async () => {
    const response = await service().handle(request({ fqdn: 'a.example.com.', value: 'v' }, basic('panel', 'secret')), 'whatever')
    expect(response.status).toBe(404)
  })

  it('still lets an issuance finish when the cleanup fails', async () => {
    const failing: DdnsFetch = async (url, init) => {
      if (url.includes('/zones?name='))
        return new Response(JSON.stringify({ success: true, result: [{ id: 'zone1', name: 'example.com' }] }), { headers: { 'Content-Type': 'application/json' } })
      if (url.includes('type=TXT'))
        return new Response(JSON.stringify({ success: true, result: [{ id: 'rec1', content: 'token-1' }] }), { headers: { 'Content-Type': 'application/json' } })
      if (init?.method === 'DELETE')
        return new Response('boom', { status: 500 })
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
    }
    const response = await service({ fetch: failing }).handle(
      request({ fqdn: '_acme-challenge.git.example.com.', value: 'token-1' }, basic('panel', 'secret')),
      'cleanup',
    )

    expect(response.status).toBe(200)
  })

  it('reports every attempt, so a failure is not only in the engine log', async () => {
    const seen: Array<{ action: string, ok: boolean }> = []
    const { fetch } = cloudflare()
    await service({ fetch, onResult: result => seen.push({ action: result.action, ok: result.ok }) }).handle(
      request({ fqdn: '_acme-challenge.git.example.com.', value: 'token-1' }, basic('panel', 'secret')),
      'present',
    )

    expect(seen).toEqual([{ action: 'present', ok: true }])
  })

  it('refuses everything while DNS-01 is off, credentials or not', async () => {
    // `auth()` returns null exactly when the feature is off. Reading that as "no
    // check to make" would leave the endpoint writing DNS with no lock at all.
    const { fetch, calls } = cloudflare()
    const response = await service({ auth: null, fetch }).handle(request({ fqdn: '_acme-challenge.git.example.com.', value: 'v' }), 'present')

    expect(response.status).toBe(403)
    expect(calls).toEqual([])
  })
})

describe('the challenge capability is declared, not assumed', () => {
  it('lists TXT support only for the providers that can write it', async () => {
    const { ddnsProviderInfos } = await import('#src/providers/ddns')
    const infos = ddnsProviderInfos()
    const byId = new Map(infos.map(info => [info.id, info]))

    expect(byId.get('cloudflare')?.txt).toBe(true)
    // A router-style Dynamic DNS password cannot write a TXT record at all.
    expect(byId.get('duckdns')?.txt).toBe(false)
    expect(byId.get('namecheap')?.txt).toBe(false)
    expect(byId.get('noip')?.txt).toBe(false)
  })
})
