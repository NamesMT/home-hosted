import type { DdnsContext, DdnsProvider, DdnsRecord, DdnsResult } from '#src/providers/ddns/types'
import { failed, missingFields, succeeded } from '#src/providers/ddns/types'
import { splitHost } from '#src/providers/ddns/zone'
import { errorMessage } from '#src/shared/error-message'

const API = 'https://api.porkbun.com/api/json/v3'

interface PorkbunEnvelope {
  status: 'SUCCESS' | 'ERROR'
  message?: string
  /**
   * The machine-readable code, documented as *"present when status is ERROR"*.
   *
   * It was not declared here, so it was never read: a rejected key answered with Porkbun's prose and
   * nothing else, and nothing could tell "your credentials are wrong" from "the provider had a moment".
   * That made every failure transient, and DDNS retries a transient one forever.
   */
  code?: string
  records?: Array<{ id: string, name: string, type: string, content: string, ttl: string }>
  warnings?: string[]
}

/** Porkbun's documented floor; `1` (automatic) maps onto it. */
function porkbunTtl(ttl: number): number {
  return Math.max(600, ttl)
}

async function post(path: string, context: DdnsContext, body: Record<string, unknown>): Promise<{ data: PorkbunEnvelope | null, error: string | null, code: string | null }> {
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
      return { data: parsed, error: parsed.message ?? `HTTP ${response.status}`, code: parsed.code ?? null }
    return { data: parsed, error: null, code: null }
  }
  catch (error) {
    return { data: null, error: errorMessage(error), code: null }
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
    if (written.error !== null) {
      /**
       * Two documented codes mean the credential is wrong, and retrying cannot fix either:
       * `INVALID_API_KEYS_001` ("API key and secret combination is invalid") and `INVALID_USER` ("Account
       * associated with the API key was not found or is not active"), from Porkbun's own reference.
       *
       * `src/services/ddns.ts` reads `permanent` to end a record, so without this the panel retried a
       * rejected key every interval forever.
       */
      const rejected = written.code === 'INVALID_API_KEYS_001' || written.code === 'INVALID_USER'
      return failed(rejected
        ? `${written.error} (${written.code})`
        : written.error, rejected)
    }

    const warnings = written.data?.warnings ?? []
    const note = warnings.length > 0 ? ` — porkbun warns: ${warnings.join('; ')}` : ''
    return succeeded(`set ${record.host} ${record.type} to ${record.ip}${note}`, true)
  },
}
