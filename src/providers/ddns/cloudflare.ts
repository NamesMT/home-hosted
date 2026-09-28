import type { DdnsContext, DdnsProvider, DdnsRecord, DdnsResult } from '#src/providers/ddns/types'
import { failed, missingFields, succeeded } from '#src/providers/ddns/types'

const API = 'https://api.cloudflare.com/client/v4'

interface CloudflareZone { id: string, name: string }
interface CloudflareRecord { id: string, content: string, ttl: number, proxied: boolean }
interface CloudflareEnvelope<T> { success: boolean, result: T, result_info?: { total_pages?: number }, errors?: Array<{ code: number, message: string }> }

function authHeaders(credentials: Record<string, string>): Record<string, string> | null {
  const token = (credentials.apiToken ?? '').trim()
  if (token.length > 0)
    return { Authorization: `Bearer ${token}` }
  const email = (credentials.email ?? '').trim()
  const key = (credentials.apiKey ?? '').trim()
  if (email.length > 0 && key.length > 0)
    return { 'X-Auth-Email': email, 'X-Auth-Key': key }
  return null
}

async function call<T>(
  path: string,
  headers: Record<string, string>,
  context: DdnsContext,
  init: RequestInit = {},
): Promise<{ data: CloudflareEnvelope<T> | null, status: number, error: string | null }> {
  try {
    const response = await context.fetch(`${API}${path}`, {
      ...init,
      headers: { ...headers, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: context.signal,
    })
    const text = await response.text()
    let parsed: CloudflareEnvelope<T>
    try {
      parsed = JSON.parse(text) as CloudflareEnvelope<T>
    }
    catch {
      return { data: null, status: response.status, error: `cloudflare answered ${response.status}: ${text.slice(0, 200)}` }
    }
    if (!response.ok || parsed.success !== true) {
      const detail = (parsed.errors ?? []).map(entry => `${entry.code} ${entry.message}`).join('; ')
      return { data: parsed, status: response.status, error: detail.length > 0 ? detail : `HTTP ${response.status}` }
    }
    return { data: parsed, status: response.status, error: null }
  }
  catch (error) {
    return { data: null, status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Walks the host's parents through `GET /zones?name=`, which is how the
 * reference image resolves a zone without a pasted zone id; the id is cached in
 * the panel's state file, so it usually costs nothing.
 */
async function resolveZone(
  host: string,
  headers: Record<string, string>,
  context: DdnsContext,
  cached: string | undefined,
): Promise<CloudflareZone | null> {
  if (cached !== undefined)
    return { id: cached, name: host }

  const labels = host.split('.')
  for (let index = 0; index <= labels.length - 2; index++) {
    const candidate = labels.slice(index).join('.')
    const { data, error } = await call<CloudflareZone[]>(`/zones?name=${encodeURIComponent(candidate)}&per_page=1`, headers, context)
    if (error !== null || data === null)
      throw new Error(error ?? 'could not look up the zone')
    const zone = data.result[0]
    if (zone !== undefined)
      return zone
  }
  return null
}

async function findRecord(
  zoneId: string,
  record: DdnsRecord,
  headers: Record<string, string>,
  context: DdnsContext,
  cached: string | undefined,
): Promise<{ record: CloudflareRecord | null, error: string | null }> {
  if (cached !== undefined) {
    const fetched = await call<CloudflareRecord>(`/zones/${zoneId}/dns_records/${cached}`, headers, context)
    if (fetched.error === null && fetched.data !== null)
      return { record: fetched.data.result, error: null }
    // A cached id the provider no longer knows is dropped; the list is the truth.
    if (fetched.status !== 404 && fetched.status !== 400)
      return { record: null, error: fetched.error }
  }

  const listed = await call<CloudflareRecord[]>(
    `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(record.host)}&per_page=100`,
    headers,
    context,
  )
  if (listed.error !== null)
    return { record: null, error: listed.error }
  const match = (listed.data?.result ?? []).find(entry => entry.id !== undefined)
  return { record: match ?? null, error: null }
}

export const cloudflareProvider: DdnsProvider = {
  id: 'cloudflare',
  label: 'Cloudflare',
  docsUrl: 'https://developers.cloudflare.com/api/resources/dns/subresources/records/',
  families: ['A', 'AAAA'],
  ttl: true,
  proxied: true,
  fields: [
    { key: 'apiToken', label: 'API token', hint: 'Zone → DNS → Edit (plus Zone → Zone → Read) for your zones. Preferred.', optional: true },
    { key: 'email', label: 'Account email', hint: 'Only for the legacy Global API Key.', optional: true },
    { key: 'apiKey', label: 'Global API key', hint: 'Legacy; prefer an API token.', optional: true },
  ],

  validate(credentials) {
    if (authHeaders(credentials ?? {}) !== null)
      return null
    return missingFields(credentials, ['apiToken'])
  },

  async update(record: DdnsRecord, context: DdnsContext): Promise<DdnsResult> {
    const headers = authHeaders(context.credentials)
    if (headers === null)
      return failed('cloudflare needs an API token (or the legacy email + global key)')

    try {
      const zone = await resolveZone(record.host, headers, context, record.cache?.zoneId)
      if (zone === null)
        return failed(`cloudflare does not have a zone for ${record.host}`)

      // A proxied record must be on automatic TTL; a TTL of 1 means automatic.
      const ttl = record.proxied ? 1 : record.ttl
      const found = await findRecord(zone.id, record, headers, context, record.cache?.recordId)
      if (found.error !== null)
        return failed(found.error)

      const existing = found.record
      if (existing !== null
        && existing.content === record.ip
        && existing.ttl === ttl
        && existing.proxied === record.proxied) {
        // The ids are still worth keeping: without them the next real change pays
        // for the zone walk and the record listing all over again.
        return { ...succeeded(`already ${record.ip}`, false), cache: { zoneId: zone.id, recordId: existing.id } }
      }

      const cache = { zoneId: zone.id, recordId: existing?.id }
      const body = JSON.stringify({ type: record.type, name: record.host, content: record.ip, ttl, proxied: record.proxied })
      // PATCH merges, so a comment or tag somebody set by hand survives an update.
      const written = existing === null
        ? await call<CloudflareRecord>(`/zones/${zone.id}/dns_records`, headers, context, { method: 'POST', body })
        : await call<CloudflareRecord>(`/zones/${zone.id}/dns_records/${existing.id}`, headers, context, { method: 'PATCH', body })
      if (written.error !== null)
        return failed(written.error)

      return { ...succeeded(`set ${record.host} ${record.type} to ${record.ip}`, true), cache: { ...cache, recordId: written.data?.result?.id ?? existing?.id } }
    }
    catch (error) {
      return failed(error instanceof Error ? error.message : String(error))
    }
  },
}
