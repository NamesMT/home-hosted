import type { DdnsContext, DdnsProvider, DdnsRecord, DdnsResult } from '#src/providers/ddns/types'
import { errorText, failed, missingFields, succeeded } from '#src/providers/ddns/types'
import { splitHost } from '#src/providers/ddns/zone'

const API = 'https://spaceship.dev/api/v1/dns/records'
const PAGE_SIZE = 500

interface SpaceshipRecord { type: string, name: string, ttl: number, address?: string }

function spaceshipTtl(ttl: number): number {
  return Math.min(3600, Math.max(60, ttl))
}

/**
 * Spaceship has no DDNS endpoint: the DNS API upserts whole record sets by
 * (name, type) and answers 204 with no body, so the only way to report
 * "unchanged" is to read the records back first.
 */
export const spaceshipProvider: DdnsProvider = {
  id: 'spaceship',
  label: 'Spaceship',
  docsUrl: 'https://docs.spaceship.dev/',
  families: ['A', 'AAAA'],
  ttl: true,
  proxied: false,
  fields: [
    { key: 'apiKey', label: 'API key', hint: 'spaceship.com → API Manager; needs the `dnsrecords:read`/`write` scopes.', optional: false },
    { key: 'apiSecret', label: 'API secret', hint: 'Shown once with the key.', optional: false },
  ],

  validate(credentials) {
    return missingFields(credentials, ['apiKey', 'apiSecret'])
  },

  async update(record: DdnsRecord, context: DdnsContext): Promise<DdnsResult> {
    const { zone, name } = splitHost(record.host, record.zone)
    const headers = {
      'X-API-Key': (context.credentials.apiKey ?? '').trim(),
      'X-API-Secret': (context.credentials.apiSecret ?? '').trim(),
      'Content-Type': 'application/json',
    }

    try {
      let found: SpaceshipRecord | undefined
      for (let skip = 0; skip < PAGE_SIZE * 5; skip += PAGE_SIZE) {
        const listed = await context.fetch(`${API}/${encodeURIComponent(zone)}?take=${PAGE_SIZE}&skip=${skip}`, { headers, signal: context.signal })
        if (!listed.ok)
          return failed(await errorText(listed))
        const body = await listed.json() as { items?: SpaceshipRecord[] } | SpaceshipRecord[]
        const items = Array.isArray(body) ? body : (body.items ?? [])
        found = items.find(entry => entry.name === name && entry.type === record.type)
        if (found !== undefined || items.length < PAGE_SIZE)
          break
      }

      if (found?.address === record.ip)
        return succeeded(`already ${record.ip}`, false)

      const written = await context.fetch(`${API}/${encodeURIComponent(zone)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ force: true, items: [{ type: record.type, name, ttl: spaceshipTtl(record.ttl), address: record.ip }] }),
        signal: context.signal,
      })
      if (!written.ok)
        return failed(await errorText(written))
      return succeeded(`set ${record.host} ${record.type} to ${record.ip}`, true)
    }
    catch (error) {
      return failed(error instanceof Error ? error.message : String(error))
    }
  },
}
