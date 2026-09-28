import type { DdnsContext, DdnsProvider, DdnsRecord, DdnsResult } from '#src/providers/ddns/types'
import { describeDyndnsResponse } from '#src/providers/ddns/dyndns2'
import { basicAuth, failed, missingFields } from '#src/providers/ddns/types'

const ENDPOINT = 'https://api.dynu.com/nic/update'

export const dynuProvider: DdnsProvider = {
  id: 'dynu',
  label: 'Dynu',
  docsUrl: 'https://www.dynu.com/DynamicDNS/IP-Update-Protocol',
  families: ['A', 'AAAA'],
  ttl: false,
  proxied: false,
  fields: [
    { key: 'username', label: 'Username', hint: 'Dynu username; used for HTTP Basic auth.', optional: false },
    { key: 'password', label: 'Password', hint: 'Account password, or its SHA-256 hash.', optional: false },
  ],

  validate(credentials) {
    return missingFields(credentials, ['username', 'password'])
  },

  async update(record: DdnsRecord, context: DdnsContext): Promise<DdnsResult> {
    const username = (context.credentials.username ?? '').trim()
    const password = (context.credentials.password ?? '').trim()
    if (username.length === 0 || password.length === 0)
      return failed('dynu needs the username and password')

    const address = record.type === 'A' ? `myip=${encodeURIComponent(record.ip)}` : `myipv6=${encodeURIComponent(record.ip)}`
    const url = `${ENDPOINT}?hostname=${encodeURIComponent(record.host)}&${address}`

    try {
      const response = await context.fetch(url, {
        headers: { Authorization: basicAuth(username, password) },
        signal: context.signal,
      })
      return describeDyndnsResponse(response, await response.text(), 'dynu')
    }
    catch (error) {
      return failed(error instanceof Error ? error.message : String(error))
    }
  },
}
