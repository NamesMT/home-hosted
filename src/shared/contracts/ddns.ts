/**
 * Dynamic DNS: the configured accounts and domains, what a pass reports, and the provider metadata a
 * settings form builds itself from.
 *
 * The block is patch-shaped twice — `ddnsConfigSchema` for the file, `ddnsPatchSchema` for a PATCH — and
 * the patch has no defaults: `accounts`/`domains` are lists it replaces, because a key-by-key merge
 * cannot express removing a hostname.
 */
import { type } from 'arktype'
import { lazy } from '../lazy'

/** A record family the DDNS engine can point at this host. */
const ddnsRecordTypeSchema = lazy(() => type.enumerated('A', 'AAAA'))
export type DdnsRecordType = typeof ddnsRecordTypeSchema.infer

/**
 * One DNS provider account. Its credentials are secrets and live in the secrets
 * file keyed by this `id`, never in the config.
 */
const ddnsAccountSchema = lazy(() => type({
  id: '/^[a-z0-9][a-z0-9_-]*$/',
  provider: 'string >= 1',
  label: 'string = ""',
}).onUndeclaredKey('reject'))
export type DdnsAccount = typeof ddnsAccountSchema.infer

/**
 * A hostname to keep pointed at this machine. That list is the whole user-facing
 * setup: the provider account it belongs to, and (optionally) which families.
 */
export const ddnsDomainSchema = lazy(() => type({
  host: '/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/',
  account: 'string >= 1',
  /** Records to keep current; `A` unless the host needs IPv6 too. */
  types: ddnsRecordTypeSchema.array().default(() => ['A' as const]),
  /**
   * The registered domain (apex) this host sits in. Only needed where a
   * provider cannot look it up and the guess is wrong (three-label suffixes).
   */
  zone: 'string?',
  /** Seconds; `1` means "automatic" where the provider supports it. */
  ttl: 'number.integer >= 1?',
  /** Proxying is a property of the record, not the panel: Cloudflare only. */
  proxied: 'boolean = false',
  enabled: 'boolean = true',
}).onUndeclaredKey('reject'))
export type DdnsDomain = typeof ddnsDomainSchema.infer

/** Which public IP families to detect; a provider is only called for the ones declared. */
const ddnsIpv4Schema = lazy(() => type({
  enabled: 'boolean = true',
  /** Override the public-IP endpoint; empty uses the built-in list. */
  url: 'string = ""',
}).onUndeclaredKey('reject'))

const ddnsIpv6Schema = lazy(() => type({
  enabled: 'boolean = false',
  url: 'string = ""',
}).onUndeclaredKey('reject'))

/**
 * Dynamic DNS: keep a list of hostnames pointed at this machine's public IP.
 * Probing is cheap and constant; a provider is only called when the address it
 * last confirmed differs, which is what keeps simple endpoints (FreeDNS, No-IP)
 * inside their rate limits.
 */
export const ddnsConfigSchema = lazy(() => type({
  enabled: 'boolean = false',
  /** How often the public address is re-checked. */
  intervalMs: 'number >= 60000 = 300000',
  ipv4: ddnsIpv4Schema.default(() => ({})),
  ipv6: ddnsIpv6Schema.default(() => ({})),
  /** Default TTL for the records that accept one. */
  ttl: 'number.integer >= 1 = 1',
  accounts: ddnsAccountSchema.array().default(() => []),
  domains: ddnsDomainSchema.array().default(() => []),
}).onUndeclaredKey('reject'))
export type DdnsConfig = typeof ddnsConfigSchema.infer

const ddnsRecordStateSchema = lazy(() => type('"pending" | "ok" | "unchanged" | "error" | "skipped"'))
export type DdnsRecordState = typeof ddnsRecordStateSchema.infer

/** What happened to one hostname on the last pass. */
const ddnsRecordViewSchema = lazy(() => type({
  'host': 'string',
  'account': 'string',
  'provider': 'string',
  'type': ddnsRecordTypeSchema,
  'ip': 'string | null',
  'state': ddnsRecordStateSchema,
  'message': 'string | null',
  'updatedAt': 'number | null',
  /** The provider refused permanently; no retry until the hostname, account or credentials change, or a check. */
  'stopped?': 'boolean',
}))
export type DdnsRecordView = typeof ddnsRecordViewSchema.infer

/** Live DDNS state, as the state frame and the settings page read it. */
export const ddnsStatusSchema = lazy(() => type({
  enabled: 'boolean',
  running: 'boolean',
  lastRunAt: 'number | null',
  lastResult: 'string | null',
  ipv4: 'string | null',
  ipv6: 'string | null',
  records: ddnsRecordViewSchema.array(),
}))
export type DdnsStatus = typeof ddnsStatusSchema.infer

/** What a provider needs from the person configuring it. */
export const ddnsProviderFieldSchema = lazy(() => type({
  key: 'string',
  label: 'string',
  hint: 'string = ""',
  optional: 'boolean = false',
}))
export type DdnsProviderField = typeof ddnsProviderFieldSchema.infer

/** Provider capabilities, so the UI knows which options to show. */
export const ddnsProviderInfoSchema = lazy(() => type({
  id: 'string',
  label: 'string',
  docsUrl: 'string',
  families: ddnsRecordTypeSchema.array(),
  fields: ddnsProviderFieldSchema.array(),
  ttl: 'boolean',
  proxied: 'boolean',
  /** These credentials can also answer an ACME DNS-01 challenge (a TXT record). */
  txt: 'boolean',
}))
export type DdnsProviderInfo = typeof ddnsProviderInfoSchema.infer

/** `GET /api/ddns`: the policy, the live state, and the providers this build knows. */
export const ddnsViewSchema = lazy(() => type({
  config: ddnsConfigSchema,
  status: ddnsStatusSchema,
  providers: ddnsProviderInfoSchema.array(),
  /** Account ids whose credentials are stored. */
  credentials: type('string[]'),
}).onDeepUndeclaredKey('ignore'))
export type DdnsView = typeof ddnsViewSchema.infer

/**
 * `PUT /api/ddns/credentials/:id`: the secret fields that provider declares.
 *
 * The provider travels with the request because the account may still be an
 * unsaved draft — the server needs its field list, not a config entry.
 */
export const ddnsCredentialsSchema = lazy(() => type({
  provider: 'string >= 1',
  credentials: type('Record<string, string>'),
}).onUndeclaredKey('reject'))

/**
 * The DDNS block as a patch: no defaults, and `accounts`/`domains` are lists a
 * patch **replaces** — a key-by-key merge cannot express removing a hostname.
 * `ipv4`/`ipv6` still merge, so a patch may decide just one of their members.
 */
export const ddnsPatchSchema = lazy(() => type({
  enabled: 'boolean?',
  intervalMs: 'number >= 60000?',
  ipv4: type({ enabled: 'boolean?', url: 'string?' }).onUndeclaredKey('reject').optional(),
  ipv6: type({ enabled: 'boolean?', url: 'string?' }).onUndeclaredKey('reject').optional(),
  ttl: 'number.integer >= 1?',
  accounts: ddnsAccountSchema.array().optional(),
  domains: ddnsDomainSchema.array().optional(),
}).onUndeclaredKey('reject'))
export type DdnsPatch = typeof ddnsPatchSchema.infer
