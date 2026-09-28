import type { DdnsContext, DdnsProvider, DdnsRecord, DdnsResult } from '#src/providers/ddns/types'
import { failed, missingFields, succeeded } from '#src/providers/ddns/types'

const ENDPOINT = 'https://freedns.afraid.org/dynamic/update.php'

/**
 * FreeDNS credentials *are* a URL: the per-record "Direct URL" hash. Both the
 * bare hash and the whole URL are accepted, because that is what people copy.
 */
function updateToken(credentials: Record<string, string>): string {
  const raw = (credentials.token ?? '').trim()
  if (raw.length === 0)
    return ''
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw
  return query.replace(/^https?:\/\/[^?]*\?/, '')
}

export const freednsProvider: DdnsProvider = {
  id: 'freedns',
  label: 'FreeDNS (afraid.org)',
  docsUrl: 'https://freedns.afraid.org/faq/',
  families: ['A', 'AAAA'],
  ttl: false,
  proxied: false,
  fields: [
    { key: 'token', label: 'Direct URL', hint: 'FreeDNS → Dynamic DNS → the per-record "Direct URL". Paste the whole URL or just its hash.', optional: false },
  ],

  validate(credentials) {
    return missingFields(credentials, ['token'])
  },

  async update(record: DdnsRecord, context: DdnsContext): Promise<DdnsResult> {
    const token = updateToken(context.credentials)
    if (token.length === 0)
      return failed('freedns needs the per-record Direct URL')

    try {
      const response = await context.fetch(`${ENDPOINT}?${token}&address=${encodeURIComponent(record.ip)}`, { signal: context.signal })
      const body = (await response.text()).trim()
      if (!response.ok || /^ERROR/i.test(body))
        return failed(`freedns answered "${body.slice(0, 160) || `HTTP ${response.status}`}"`)
      return succeeded(`set ${record.host} ${record.type} to ${record.ip}`, true)
    }
    catch (error) {
      return failed(error instanceof Error ? error.message : String(error))
    }
  },
}
