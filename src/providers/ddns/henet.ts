import type { DdnsContext, DdnsProvider, DdnsRecord, DdnsResult } from '#src/providers/ddns/types'
import { describeDyndnsResponse } from '#src/providers/ddns/dyndns2'
import { failed, missingFields } from '#src/providers/ddns/types'

const ENDPOINT = 'https://dyn.dns.he.net/nic/update'

/** Hurricane Electric keeps a per-host DDNS key, shown in its DNS panel. */
export const henetProvider: DdnsProvider = {
  id: 'henet',
  label: 'Hurricane Electric',
  docsUrl: 'https://dns.he.net/docs.html',
  families: ['A', 'AAAA'],
  ttl: false,
  proxied: false,
  fields: [
    { key: 'key', label: 'DDNS key', hint: 'dns.he.net → the key shown next to the host when DDNS is enabled.', optional: false },
  ],

  validate(credentials) {
    return missingFields(credentials, ['key'])
  },

  async update(record: DdnsRecord, context: DdnsContext): Promise<DdnsResult> {
    const key = (context.credentials.key ?? '').trim()
    if (key.length === 0)
      return failed('hurricane electric needs the per-host DDNS key')

    const url = `${ENDPOINT}?hostname=${encodeURIComponent(record.host)}&password=${encodeURIComponent(key)}&myip=${encodeURIComponent(record.ip)}`

    try {
      const response = await context.fetch(url, { signal: context.signal })
      return describeDyndnsResponse(response, await response.text(), 'hurricane electric')
    }
    catch (error) {
      return failed(error instanceof Error ? error.message : String(error))
    }
  },
}
