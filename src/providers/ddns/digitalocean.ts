import type { DdnsContext, DdnsProvider, DdnsRecord, DdnsResult } from '#src/providers/ddns/types'
import { errorText, failed, missingFields, succeeded } from '#src/providers/ddns/types'
import { splitHost } from '#src/providers/ddns/zone'

const API = 'https://api.digitalocean.com/v2/domains'

interface DigitalOceanRecord { id: number, type: string, name: string, data: string, ttl: number }

function oceanTtl(ttl: number): number {
  return Math.max(30, ttl)
}

export const digitaloceanProvider: DdnsProvider = {
  id: 'digitalocean',
  label: 'DigitalOcean',
  docsUrl: 'https://docs.digitalocean.com/reference/api/api-reference/#tag/Domain-Records',
  families: ['A', 'AAAA'],
  ttl: true,
  proxied: false,
  fields: [
    { key: 'token', label: 'API token', hint: 'A personal access token with the `domain` scope.', optional: false },
  ],

  validate(credentials) {
    return missingFields(credentials, ['token'])
  },

  async update(record: DdnsRecord, context: DdnsContext): Promise<DdnsResult> {
    const { zone, name } = splitHost(record.host, record.zone)
    const ttl = oceanTtl(record.ttl)
    const headers = { 'Authorization': `Bearer ${(context.credentials.token ?? '').trim()}`, 'Content-Type': 'application/json' }
    const collection = `${API}/${encodeURIComponent(zone)}/records`

    try {
      const listed = await context.fetch(`${collection}?per_page=200`, { headers, signal: context.signal })
      if (!listed.ok)
        return failed(await errorText(listed))
      const body = await listed.json() as { domain_records?: DigitalOceanRecord[] }
      const existing = (body.domain_records ?? []).find(entry => entry.name === name && entry.type === record.type)

      if (existing !== undefined && existing.data === record.ip)
        return succeeded(`already ${record.ip}`, false)

      const written = existing === undefined
        ? await context.fetch(collection, {
            method: 'POST',
            headers,
            body: JSON.stringify({ type: record.type, name, data: record.ip, ttl }),
            signal: context.signal,
          })
        : await context.fetch(`${collection}/${existing.id}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ type: record.type, name, data: record.ip, ttl }),
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
