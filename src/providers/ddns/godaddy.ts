import type { DdnsContext, DdnsProvider, DdnsRecord, DdnsResult } from '#src/providers/ddns/types'
import { errorText, failed, missingFields, succeeded } from '#src/providers/ddns/types'
import { splitHost } from '#src/providers/ddns/zone'

const API = 'https://api.godaddy.com/v1/domains'

/** GoDaddy's floor; `1` (automatic) has no meaning here. */
function godaddyTtl(ttl: number): number {
  return Math.min(86_400, Math.max(600, ttl))
}

interface GoDaddyRecord { data: string, ttl: number, name: string, type: string }

export const godaddyProvider: DdnsProvider = {
  id: 'godaddy',
  label: 'GoDaddy',
  docsUrl: 'https://developer.godaddy.com/doc/endpoint/dns',
  families: ['A', 'AAAA'],
  ttl: true,
  proxied: false,
  fields: [
    { key: 'key', label: 'API key', hint: 'developer.godaddy.com/keys.', optional: false },
    { key: 'secret', label: 'API secret', hint: 'Shown once with the key.', optional: false },
    {
      key: 'baseUrl',
      label: 'API base URL',
      hint: 'Optional; use https://api.ote-godaddy.com to rehearse against the test environment.',
      optional: true,
    },
  ],

  validate(credentials) {
    return missingFields(credentials, ['key', 'secret'])
  },

  async update(record: DdnsRecord, context: DdnsContext): Promise<DdnsResult> {
    const { zone, name } = splitHost(record.host, record.zone)
    const ttl = godaddyTtl(record.ttl)
    const base = (context.credentials.baseUrl ?? '').trim() || API
    const url = `${base}/${encodeURIComponent(zone)}/records/${record.type}/${encodeURIComponent(name)}`
    const headers = {
      'Authorization': `sso-key ${context.credentials.key ?? ''}:${context.credentials.secret ?? ''}`,
      'Content-Type': 'application/json',
    }

    try {
      const current = await context.fetch(url, { headers, signal: context.signal })
      if (current.ok) {
        const body = await current.json() as GoDaddyRecord[]
        if (body.length === 1 && body[0]?.data === record.ip)
          return succeeded(`already ${record.ip}`, false)
      }

      const written = await context.fetch(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify([{ data: record.ip, ttl }]),
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
