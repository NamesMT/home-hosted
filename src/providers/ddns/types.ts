import type { DdnsProviderField, DdnsRecordType } from '#src/shared/contracts'
import { Buffer } from 'node:buffer'

/**
 * One record to keep current. Providers are stateless adapters over one HTTP
 * call each, so everything they need is resolved before they are called.
 */
/** Provider ids the panel may have cached (a Cloudflare zone, a record), so the next pass skips lookups. */
export interface DdnsRecordCache {
  zoneId?: string
  recordId?: string
}

export interface DdnsRecord {
  host: string
  type: DdnsRecordType
  ip: string
  /** The registered domain, when the config pins it; providers that need a zone fall back to a heuristic. */
  zone?: string
  /** Seconds; `1` is "automatic" where the provider supports it. */
  ttl: number
  proxied: boolean
  cache?: DdnsRecordCache
}

export type DdnsFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface DdnsContext {
  /** Whatever the person stored for this account; provider fields only. */
  credentials: Record<string, string>
  fetch: DdnsFetch
  signal?: AbortSignal
}

export interface DdnsResult {
  ok: boolean
  /** False when the provider already served exactly this address. */
  changed: boolean
  message: string
  error?: string
  /** Provider ids worth remembering, so the next pass skips a lookup. */
  cache?: DdnsRecordCache
}

export interface DdnsProvider {
  id: string
  label: string
  docsUrl: string
  /** Record families this provider can manage. */
  families: DdnsRecordType[]
  fields: DdnsProviderField[]
  /** The provider honours a per-record TTL. */
  ttl: boolean
  /** The provider has a proxy/CDN flag (Cloudflare). */
  proxied: boolean
  /**
   * Non-null when the stored credentials cannot drive this provider yet.
   */
  validate: (credentials: Record<string, string> | null) => string | null
  /**
   * Keeps one address record current. Absent for a provider that exists only to
   * answer DNS-01 challenges — an account on one of those cannot be used as a DDNS
   * hostname, and saying so beats a stub that pretends to work.
   */
  update?: (record: DdnsRecord, context: DdnsContext) => Promise<DdnsResult>
  /**
   * Present when these credentials can answer an ACME DNS-01 challenge, which
   * needs a temporary `TXT` record — a capability the update path does not imply.
   * A router-style Dynamic DNS password cannot write TXT, so it is absent there.
   */
  challenge?: (record: DdnsChallengeRecord, context: DdnsContext) => Promise<DdnsChallengeResult>
}

/** One `_acme-challenge` TXT record, as the ACME server asked for it. */
export interface DdnsChallengeRecord {
  /** The full name the CA reads, e.g. `_acme-challenge.git.example.com`. */
  fqdn: string
  /** The value the CA expects to find. */
  value: string
  /** `present` writes it, `cleanup` removes it again. */
  action: 'present' | 'cleanup'
}

export interface DdnsChallengeResult {
  ok: boolean
  message: string
}

export function succeeded(message: string, changed: boolean): DdnsResult {
  return { ok: true, changed, message }
}

export function failed(error: string): DdnsResult {
  return { ok: false, changed: false, message: error, error }
}

/** Missing required credential keys, as a sentence for the settings page. */
export function missingFields(credentials: Record<string, string> | null, keys: string[]): string | null {
  const missing = keys.filter(key => (credentials?.[key] ?? '').trim().length === 0)
  return missing.length === 0 ? null : `set ${missing.join(', ')}`
}

export function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
}

/** A provider error body is useful, but never worth throwing over. */
export async function errorText(response: Response, limit = 300): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim()
    return text.length === 0 ? `HTTP ${response.status}` : `HTTP ${response.status}: ${text.slice(0, limit)}`
  }
  catch {
    return `HTTP ${response.status}`
  }
}

const NORMALIZE_DOTS = /\.$/

/** `Sub.Domain.COM.` -> `sub.domain.com`; DuckDNS and friends are case-insensitive. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(NORMALIZE_DOTS, '')
}
