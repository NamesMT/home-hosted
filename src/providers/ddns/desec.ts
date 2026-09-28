import type { DdnsContext, DdnsProvider, DdnsRecord, DdnsResult } from '#src/providers/ddns/types'
import { describeDyndnsResponse } from '#src/providers/ddns/dyndns2'
import { basicAuth, failed, missingFields } from '#src/providers/ddns/types'

const ENDPOINT = 'https://update.dedyn.io/'

export const desecProvider: DdnsProvider = {
  id: 'desec',
  label: 'deSEC',
  docsUrl: 'https://desec.readthedocs.io/en/latest/dyndns/update-api.html',
  families: ['A', 'AAAA'],
  ttl: false,
  proxied: false,
  fields: [
    { key: 'token', label: 'API token', hint: 'desec.io → Token management; the token must allow the RRset update.', optional: false },
  ],

  validate(credentials) {
    return missingFields(credentials, ['token'])
  },

  async update(record: DdnsRecord, context: DdnsContext): Promise<DdnsResult> {
    const token = (context.credentials.token ?? '').trim()
    if (token.length === 0)
      return failed('desec needs an API token')

    // Basic auth binds the token to the hostname, so the token never rides in a URL.
    const family = record.type === 'A' ? `myipv4=${encodeURIComponent(record.ip)}` : `myipv6=${encodeURIComponent(record.ip)}`
    const url = `${ENDPOINT}?hostname=${encodeURIComponent(record.host)}&${family}`

    try {
      const response = await context.fetch(url, {
        headers: { Authorization: basicAuth(record.host, token) },
        signal: context.signal,
      })
      return describeDyndnsResponse(response, await response.text(), 'desec')
    }
    catch (error) {
      return failed(error instanceof Error ? error.message : String(error))
    }
  },
}
