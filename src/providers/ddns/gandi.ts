import type { DdnsContext, DdnsProvider, DdnsRecord, DdnsResult } from '#src/providers/ddns/types'
import { errorText, failed, missingFields, succeeded } from '#src/providers/ddns/types'
import { splitHost } from '#src/providers/ddns/zone'

const API = 'https://api.gandi.net/v5/livedns/domains'

/** Gandi's documented minimum; `1` (automatic) has no meaning here. */
function gandiTtl(ttl: number): number {
  return Math.min(2_592_000, Math.max(300, ttl))
}

/** A Personal Access Token (`pat_…`) is preferred; the legacy API key is still accepted. */
function authHeader(token: string): string {
  return token.startsWith('pat_') ? `Bearer ${token}` : `Apikey ${token}`
}

export const gandiProvider: DdnsProvider = {
  id: 'gandi',
  label: 'Gandi',
  docsUrl: 'https://api.gandi.net/docs/livedns/',
  families: ['A', 'AAAA'],
  ttl: true,
  proxied: false,
  fields: [
    { key: 'token', label: 'Personal access token', hint: 'A `pat_…` token from admin.gandi.net → Organizations. A legacy API key also works.', optional: false },
  ],

  validate(credentials) {
    return missingFields(credentials, ['token'])
  },

  async update(record: DdnsRecord, context: DdnsContext): Promise<DdnsResult> {
    const token = (context.credentials.token ?? '').trim()
    if (token.length === 0)
      return failed('gandi needs an API token')

    const { zone, name } = splitHost(record.host, record.zone)
    const ttl = gandiTtl(record.ttl)
    const url = `${API}/${encodeURIComponent(zone)}/records/${encodeURIComponent(name)}/${record.type}`
    const headers = { 'Authorization': authHeader(token), 'Content-Type': 'application/json' }

    try {
      const current = await context.fetch(url, { headers, signal: context.signal })
      if (current.ok) {
        const body = await current.json() as { rrset_values?: string[], rrset_ttl?: number }
        if (body.rrset_values?.length === 1 && body.rrset_values[0] === record.ip)
          return succeeded(`already ${record.ip}`, false)
      }

      const written = await context.fetch(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ rrset_values: [record.ip], rrset_ttl: ttl }),
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
