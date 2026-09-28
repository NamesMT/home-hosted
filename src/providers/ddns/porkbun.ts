import type { DdnsContext, DdnsProvider, DdnsRecord, DdnsResult } from '#src/providers/ddns/types'
import { failed, missingFields, succeeded } from '#src/providers/ddns/types'
import { splitHost } from '#src/providers/ddns/zone'

const API = 'https://api.porkbun.com/api/json/v3'

interface PorkbunEnvelope {
  status: 'SUCCESS' | 'ERROR'
  message?: string
  records?: Array<{ id: string, name: string, type: string, content: string, ttl: string }>
  warnings?: string[]
}

/** Porkbun's documented floor; `1` (automatic) maps onto it. */
function porkbunTtl(ttl: number): number {
  return Math.max(600, ttl)
}

async function post(path: string, context: DdnsContext, body: Record<string, unknown>): Promise<{ data: PorkbunEnvelope | null, error: string | null }> {
  try {
    const response = await context.fetch(`${API}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': context.credentials.apikey ?? '',
        'X-Secret-API-Key': context.credentials.secretapikey ?? '',
      },
      body: JSON.stringify(body),
      signal: context.signal,
    })
    const parsed = JSON.parse(await response.text()) as PorkbunEnvelope
    if (parsed.status !== 'SUCCESS')
      return { data: parsed, error: parsed.message ?? `HTTP ${response.status}` }
    return { data: parsed, error: null }
  }
  catch (error) {
    return { data: null, error: error instanceof Error ? error.message : String(error) }
  }
}

export const porkbunProvider: DdnsProvider = {
  id: 'porkbun',
  label: 'Porkbun',
  docsUrl: 'https://porkbun.com/api/json/v3/documentation',
  families: ['A', 'AAAA'],
  ttl: true,
  proxied: false,
  fields: [
    { key: 'apikey', label: 'API key', hint: 'porkbun.com/account/api — starts with pk1_.', optional: false },
    { key: 'secretapikey', label: 'Secret API key', hint: 'Shown once when the key is created.', optional: false },
  ],

  validate(credentials) {
    return missingFields(credentials, ['apikey', 'secretapikey'])
  },

  async update(record: DdnsRecord, context: DdnsContext): Promise<DdnsResult> {
    const { zone, name: rawName } = splitHost(record.host, record.zone)
    // Porkbun uses a blank name for the apex, and `*` for a wildcard.
    const name = rawName === '@' ? '' : rawName
    const ttl = porkbunTtl(record.ttl)

    const listed = await post(`/dns/retrieveByNameType/${encodeURIComponent(zone)}/${record.type}/${encodeURIComponent(name)}`, context, {})
    const existing = listed.data?.records?.[0]
    if (existing !== undefined && existing.content === record.ip && Number.parseInt(existing.ttl, 10) === ttl)
      return succeeded(`already ${record.ip}`, false)

    const written = await post(`/dns/editByNameType/${encodeURIComponent(zone)}/${record.type}/${encodeURIComponent(name)}`, context, {
      content: record.ip,
      ttl,
    })
    if (written.error !== null)
      return failed(written.error)

    const warnings = written.data?.warnings ?? []
    const note = warnings.length > 0 ? ` — porkbun warns: ${warnings.join('; ')}` : ''
    return succeeded(`set ${record.host} ${record.type} to ${record.ip}${note}`, true)
  },
}
