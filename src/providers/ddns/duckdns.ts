import type { DdnsContext, DdnsProvider, DdnsRecord, DdnsResult } from '#src/providers/ddns/types'
import { failed, missingFields, succeeded } from '#src/providers/ddns/types'

const ENDPOINT = 'https://www.duckdns.org/update'

/** DuckDNS addresses one subdomain at a time, so the label is the domain. */
function subdomain(host: string): string {
  const normalized = host.trim().toLowerCase()
  return normalized.endsWith('.duckdns.org') ? normalized.slice(0, -'.duckdns.org'.length) : normalized
}

export const duckdnsProvider: DdnsProvider = {
  id: 'duckdns',
  label: 'DuckDNS',
  docsUrl: 'https://www.duckdns.org/spec.jsp',
  families: ['A', 'AAAA'],
  ttl: false,
  proxied: false,
  fields: [
    { key: 'token', label: 'Account token', hint: 'On duckdns.org after signing in. One token covers every subdomain.', optional: false },
  ],

  validate(credentials) {
    return missingFields(credentials, ['token'])
  },

  async update(record: DdnsRecord, context: DdnsContext): Promise<DdnsResult> {
    const token = (context.credentials.token ?? '').trim()
    if (token.length === 0)
      return failed('duckdns needs the account token')

    const family = record.type === 'A' ? `ip=${encodeURIComponent(record.ip)}` : `ipv6=${encodeURIComponent(record.ip)}`
    const url = `${ENDPOINT}?domains=${encodeURIComponent(subdomain(record.host))}&token=${encodeURIComponent(token)}&${family}`

    try {
      const response = await context.fetch(url, { signal: context.signal })
      const body = (await response.text()).trim()
      if (body.toUpperCase() === 'OK')
        return succeeded(`set ${record.host} ${record.type} to ${record.ip}`, true)
      return failed(`duckdns answered "${body.slice(0, 120) || `HTTP ${response.status}`}"`)
    }
    catch (error) {
      return failed(error instanceof Error ? error.message : String(error))
    }
  },
}
