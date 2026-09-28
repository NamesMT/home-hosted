import type { DdnsContext, DdnsProvider, DdnsRecord, DdnsResult } from '#src/providers/ddns/types'
import { describeDyndnsResponse } from '#src/providers/ddns/dyndns2'
import { basicAuth, failed, missingFields } from '#src/providers/ddns/types'

const ENDPOINT = 'https://dynupdate.no-ip.com/nic/update'

/** No-IP rate-limits clients whose User-Agent it does not recognise. */
const DEFAULT_AGENT = 'home-hosted/1.0 (+https://github.com/NamesMT/home-hosted)'

export const noipProvider: DdnsProvider = {
  id: 'noip',
  label: 'No-IP',
  docsUrl: 'https://www.noip.com/integrate/request',
  families: ['A', 'AAAA'],
  ttl: false,
  proxied: false,
  fields: [
    { key: 'username', label: 'Email', hint: 'Your No-IP account email.', optional: false },
    { key: 'password', label: 'Password', hint: 'Your No-IP account password.', optional: false },
    {
      key: 'userAgent',
      label: 'User-Agent override',
      hint: 'No-IP only guarantees updates for recognised clients; set an approved agent here if yours is registered.',
      optional: true,
    },
  ],

  validate(credentials) {
    return missingFields(credentials, ['username', 'password'])
  },

  async update(record: DdnsRecord, context: DdnsContext): Promise<DdnsResult> {
    const username = (context.credentials.username ?? '').trim()
    const password = (context.credentials.password ?? '').trim()
    if (username.length === 0 || password.length === 0)
      return failed('no-ip needs the account email and password')

    const address = record.type === 'A' ? `myip=${encodeURIComponent(record.ip)}` : `myipv6=${encodeURIComponent(record.ip)}`
    const url = `${ENDPOINT}?hostname=${encodeURIComponent(record.host)}&${address}`

    try {
      const response = await context.fetch(url, {
        headers: {
          'Authorization': basicAuth(username, password),
          'User-Agent': (context.credentials.userAgent ?? '').trim() || DEFAULT_AGENT,
        },
        signal: context.signal,
      })
      return describeDyndnsResponse(response, await response.text(), 'no-ip')
    }
    catch (error) {
      return failed(error instanceof Error ? error.message : String(error))
    }
  },
}
