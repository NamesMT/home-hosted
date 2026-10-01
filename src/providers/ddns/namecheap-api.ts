import type { DdnsChallengeRecord, DdnsChallengeResult, DdnsContext, DdnsProvider } from '#src/providers/ddns/types'
import { normalizeHost } from '#src/providers/ddns/types'
import { splitHost } from '#src/providers/ddns/zone'

/**
 * Namecheap through its XML API, which is the only way to write a `TXT` record
 * there: the router-style Dynamic DNS endpoint in `namecheap.ts` updates an
 * address and nothing else, and its password is not this one.
 *
 * The API has no "add one record" call. `setHosts` **replaces the whole record
 * set**, so answering a challenge means reading every record, writing them all
 * back with one added (or removed) — twice per issuance. That is why this is a
 * separate provider with its own credentials rather than a mode of the other one:
 * the failure mode is different in kind, and nobody should reach it by accident.
 */

const ENDPOINT = 'https://api.namecheap.com/xml.response'

/**
 * The most host records one `setHosts` call can carry. A zone with more than this
 * cannot be rewritten through the API at all, which is why the guard refuses rather
 * than sending a call that would silently drop the records it could not express.
 */
const RECORD_LIMIT = 150

/** TTL for the challenge record: short, because it is deleted minutes later. */
const CHALLENGE_TTL = 60

export interface NamecheapRecord {
  name: string
  type: string
  address: string
  mxPref: string
  ttl: string
}

interface ApiReply {
  status: string
  errors: string[]
  body: string
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' }

/**
 * Namecheap escapes attribute values, so a value read back has to be unescaped
 * before it is written out again: the whole-zone rewrite would otherwise turn
 * `a&b` into `a&amp;b` on every challenge, corrupting a record we did not create.
 */
function decodeXml(value: string): string {
  return value.replace(/&(#X?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      return Number.isInteger(code) && code >= 0 && code <= 0x10_FF_FF ? String.fromCodePoint(code) : whole
    }
    return XML_ENTITIES[body.toLowerCase()] ?? whole
  })
}

function attr(tagText: string, name: string): string {
  const match = new RegExp(`${name}="([^"]*)"`, 'i').exec(tagText)
  return decodeXml(match?.[1] ?? '').trim()
}

/** Every `<Host ... />` in a `getHosts` reply, in the order the API listed them. */
export function parseHosts(body: string): NamecheapRecord[] {
  const records: NamecheapRecord[] = []
  const pattern = /<Host\b([^>]*?)(?:\/>|>)/gi
  let match = pattern.exec(body)
  while (match !== null) {
    const attributes = match[1] ?? ''
    records.push({
      name: attr(attributes, 'Name'),
      type: attr(attributes, 'Type'),
      address: attr(attributes, 'Address'),
      mxPref: attr(attributes, 'MXPref') || '10',
      ttl: attr(attributes, 'TTL') || '1800',
    })
    match = pattern.exec(body)
  }
  return records
}

/** The first `<Err1>`…`<ErrN>` a failed reply carries, as one sentence. */
export function describeErrors(body: string): string {
  const errors: string[] = []
  const pattern = /<Err\d+>([\s\S]*?)<\/Err\d+>/gi
  let match = pattern.exec(body)
  while (match !== null) {
    const text = (match[1] ?? '').trim()
    if (text.length > 0)
      errors.push(text)
    match = pattern.exec(body)
  }
  return errors.length > 0 ? errors.join('; ') : 'the API refused the request'
}

function credentials(store: Record<string, string>): { apiUser: string, apiKey: string, userName: string, clientIp: string } | null {
  const apiUser = (store.apiUser ?? '').trim()
  const apiKey = (store.apiKey ?? '').trim()
  const userName = (store.userName ?? '').trim() || apiUser
  const clientIp = (store.clientIp ?? '').trim()
  if (apiUser.length === 0 || apiKey.length === 0 || clientIp.length === 0)
    return null
  return { apiUser, apiKey, userName, clientIp }
}

/** One XML call. Namecheap answers HTTP 200 whatever happened, so the body decides. */
async function call(command: string, params: Record<string, string>, context: DdnsContext): Promise<ApiReply | string> {
  const auth = credentials(context.credentials)
  if (auth === null)
    return 'namecheap needs the API user, the API key and the whitelisted client IP'

  const query = new URLSearchParams({
    ApiUser: auth.apiUser,
    ApiKey: auth.apiKey,
    UserName: auth.userName,
    ClientIp: auth.clientIp,
    Command: command,
    ...params,
  })

  try {
    const response = await context.fetch(`${ENDPOINT}?${query.toString()}`, { signal: context.signal })
    const body = await response.text()
    if (!response.ok && !body.includes('<ApiResponse'))
      return `namecheap answered HTTP ${response.status}`
    const status = /<ApiResponse[^>]*Status="([^"]*)"/i.exec(body)?.[1] ?? ''
    if (status.toUpperCase() !== 'OK')
      return describeErrors(body)
    return { status, errors: [], body }
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The registered domain split into the `SLD`/`TLD` pair the API asks for. */
function apexParts(zone: string): { SLD: string, TLD: string } {
  const apex = normalizeHost(zone)
  const dot = apex.indexOf('.')
  if (dot < 0)
    return { SLD: apex, TLD: '' }
  return { SLD: apex.slice(0, dot), TLD: apex.slice(dot + 1) }
}

/** The zone's records, or a sentence saying why they could not be read. */
async function readHosts(zone: string, context: DdnsContext): Promise<NamecheapRecord[] | string> {
  const reply = await call('namecheap.domains.dns.getHosts', { ...apexParts(zone) }, context)
  if (typeof reply === 'string')
    return reply
  return parseHosts(reply.body)
}

/** Writes the whole record set back. */
async function writeHosts(zone: string, records: NamecheapRecord[], context: DdnsContext): Promise<string | null> {
  const params: Record<string, string> = { ...apexParts(zone) }
  records.forEach((record, index) => {
    const at = index + 1
    params[`HostName${at}`] = record.name
    params[`RecordType${at}`] = record.type
    params[`Address${at}`] = record.address
    params[`TTL${at}`] = record.ttl
    // The API carries MXPref on every record; sending it back unchanged keeps an
    // MX record's preference from being silently reset to the default.
    params[`MXPref${at}`] = record.mxPref
  })

  const reply = await call('namecheap.domains.dns.setHosts', params, context)
  return typeof reply === 'string' ? reply : null
}

/** The record name Namecheap expects for a challenge, relative to the zone. */
function challengeName(fqdn: string, zone: string): string {
  const normalized = normalizeHost(fqdn)
  const apex = normalizeHost(zone)
  if (normalized === apex)
    return '@'
  return normalized.endsWith(`.${apex}`) ? normalized.slice(0, -(apex.length + 1)) : normalized
}

export const namecheapApiProvider: DdnsProvider = {
  id: 'namecheap-api',
  label: 'Namecheap (API)',
  docsUrl: 'https://www.namecheap.com/support/api/methods/domains-dns/set-hosts/',
  // The XML API can manage any record type, but this entry exists for DNS-01:
  // address updates belong to the Dynamic DNS provider, whose password is easier
  // to live with than an IP-whitelisted API key.
  families: ['A'],
  ttl: true,
  proxied: false,
  fields: [
    { key: 'apiUser', label: 'API user', hint: 'Dashboard → Profile → Tools → Namecheap API Access. Usually your account name.', optional: false },
    { key: 'apiKey', label: 'API key', hint: 'Shown once when API access is enabled.', optional: false },
    { key: 'userName', label: 'User name', hint: 'Leave empty unless the API user differs from the account.', optional: true },
    { key: 'clientIp', label: 'Whitelisted IP', hint: 'The public IPv4 this panel calls from. It must be whitelisted under API Access, and error 1017105 means it is not.', optional: false },
  ],

  validate(store) {
    if (credentials(store ?? {}) !== null)
      return null
    const missing = ['apiUser', 'apiKey', 'clientIp'].filter(key => (store?.[key] ?? '').trim().length === 0)
    return missing.length === 0 ? null : `set ${missing.join(', ')}`
  },

  /**
   * There is no per-record update here: `setHosts` replaces everything, so this is
   * a read-modify-write of the whole zone.
   */
  async challenge(record: DdnsChallengeRecord, context: DdnsContext): Promise<DdnsChallengeResult> {
    const { zone } = splitHost(record.fqdn)
    const hosts = await readHosts(zone, context)
    if (typeof hosts === 'string')
      return { ok: false, message: hosts }

    const name = challengeName(record.fqdn, zone)
    const isChallenge = (host: NamecheapRecord) => host.type.toUpperCase() === 'TXT' && host.name.toLowerCase() === name.toLowerCase()
    // Scoped by value, not just by name: a second challenge for the same hostname
    // (or somebody's own TXT) must survive our cleanup.
    const isOurs = (host: NamecheapRecord) => isChallenge(host) && host.address === record.value

    if (record.action === 'present') {
      if (hosts.some(isOurs))
        return { ok: true, message: `${record.fqdn} already carries this value` }
      if (hosts.length >= RECORD_LIMIT) {
        return {
          ok: false,
          message: `namecheap's setHosts takes at most ${RECORD_LIMIT} host records per call and ${zone} has ${hosts.length}, so the panel cannot rewrite this zone to add a challenge record`,
        }
      }
      const failure = await writeHosts(zone, [...hosts, {
        name,
        type: 'TXT',
        address: record.value,
        mxPref: '10',
        ttl: String(CHALLENGE_TTL),
      }], context)
      if (failure !== null)
        return { ok: false, message: failure }
      return { ok: true, message: `added a TXT record for ${record.fqdn} (rewrote ${hosts.length} others)` }
    }

    const kept = hosts.filter(host => !isOurs(host))
    if (kept.length === hosts.length)
      return { ok: true, message: `${record.fqdn} had no challenge record to remove` }
    const failure = await writeHosts(zone, kept, context)
    if (failure !== null)
      return { ok: false, message: failure }
    return { ok: true, message: `removed the TXT record for ${record.fqdn} (rewrote ${kept.length} others)` }
  },
}
