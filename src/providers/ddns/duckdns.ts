import type { DdnsContext, DdnsProvider, DdnsRecord, DdnsResult } from '#src/providers/ddns/types'
import { failed, missingFields, succeeded } from '#src/providers/ddns/types'
import { errorMessage } from '#src/shared/error-message'

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
      /**
       * `KO` is duckdns's whole vocabulary for "no", and it means the **token or the domain was
       * rejected** — the same inputs will get the same answer.
       *
       * Reported as transient it was retried every interval forever: a mistyped token produced
       * `duckdns answered "KO"` on the settings page indefinitely, with nothing saying what to fix.
       * `permanent` is what stops the retry loop (`src/services/ddns.ts` reads it to end the record),
       * and the message now names the two things a person can act on.
       */
      if (body.toUpperCase() === 'KO')
        return failed('duckdns rejected the token or the domain — check both in the account settings', true)
      return failed(`duckdns answered "${body.slice(0, 120) || `HTTP ${response.status}`}"`)
    }
    catch (error) {
      return failed(errorMessage(error))
    }
  },
}
