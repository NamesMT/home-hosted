import type { DdnsContext, DdnsProvider, DdnsRecord, DdnsResult } from '#src/providers/ddns/types'
import { failed, missingFields, succeeded } from '#src/providers/ddns/types'
import { splitHost } from '#src/providers/ddns/zone'

const ENDPOINT = 'https://dynamicdns.park-your-domain.com/update'

function tag(body: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(body)
  return match?.[1]?.trim() ?? null
}

/**
 * Namecheap's router-style Dynamic DNS: one GET, one A record, HTTP 200 even on
 * failure — the XML `ErrCount` is the only truth.
 */
export const namecheapProvider: DdnsProvider = {
  id: 'namecheap',
  label: 'Namecheap',
  docsUrl: 'https://www.namecheap.com/support/knowledgebase/article.aspx/29/11/how-to-dynamically-update-the-hosts-ip-with-an-https-request/',
  families: ['A'],
  ttl: false,
  proxied: false,
  fields: [
    {
      key: 'password',
      label: 'Dynamic DNS password',
      hint: 'Dashboard → Manage domain → Advanced DNS → Dynamic DNS. Not your account password or API key.',
      optional: false,
    },
  ],

  validate(credentials) {
    return missingFields(credentials, ['password'])
  },

  async update(record: DdnsRecord, context: DdnsContext): Promise<DdnsResult> {
    const password = (context.credentials.password ?? '').trim()
    if (password.length === 0)
      return failed('namecheap needs the Dynamic DNS password')

    const { zone, name } = splitHost(record.host, record.zone)
    const host = name === '@' ? '@' : name
    const url = `${ENDPOINT}?host=${encodeURIComponent(host)}&domain=${encodeURIComponent(zone)}&password=${encodeURIComponent(password)}&ip=${encodeURIComponent(record.ip)}`

    try {
      const response = await context.fetch(url, { signal: context.signal })
      const body = await response.text()
      const errCount = Number.parseInt(tag(body, 'ErrCount') ?? '0', 10)
      const ip = tag(body, 'IP')
      if (errCount > 0) {
        const first = tag(body, 'Err1')
        return failed(`namecheap rejected the update${first === null ? '' : `: ${first}`}`)
      }
      if (ip === null)
        return failed(`namecheap answered without an IP: ${body.replace(/\s+/g, ' ').slice(0, 160)}`)
      return succeeded(`${host === '@' ? zone : `${host}.${zone}`} now ${ip}`, ip !== record.ip)
    }
    catch (error) {
      return failed(error instanceof Error ? error.message : String(error))
    }
  },
}
