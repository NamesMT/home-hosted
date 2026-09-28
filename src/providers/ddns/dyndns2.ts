import type { DdnsResult } from '#src/providers/ddns/types'
import { failed, succeeded } from '#src/providers/ddns/types'

/**
 * The dyndns2 reply vocabulary, shared by every `…/nic/update` endpoint. A
 * provider that answers something else maps its own text instead.
 */
const CODES: Record<string, { ok: boolean, changed: boolean, message: string, permanent: boolean }> = {
  'good': { ok: true, changed: true, message: 'updated', permanent: false },
  'nochg': { ok: true, changed: false, message: 'already current', permanent: false },
  'nohost': { ok: false, changed: false, message: 'the provider does not know this hostname', permanent: true },
  'notfqdn': { ok: false, changed: false, message: 'the provider wants a fully qualified hostname', permanent: true },
  'numhost': { ok: false, changed: false, message: 'too many hostnames for this provider', permanent: true },
  'badauth': { ok: false, changed: false, message: 'the provider rejected the credentials', permanent: true },
  'badagent': { ok: false, changed: false, message: 'the provider rejected this client (User-Agent)', permanent: true },
  '!donator': { ok: false, changed: false, message: 'this feature needs a paid provider plan', permanent: true },
  'abuse': { ok: false, changed: false, message: 'the provider blocked this account for abuse', permanent: true },
  'dnserr': { ok: false, changed: false, message: 'the provider had a DNS error', permanent: false },
  'servererror': { ok: false, changed: false, message: 'the provider had a server error', permanent: false },
  '911': { ok: false, changed: false, message: 'the provider is down; it asks you to wait about 30 minutes', permanent: false },
  'unknown': { ok: false, changed: false, message: 'the provider answered with an unknown error', permanent: false },
}

export interface DyndnsReply {
  code: string
  /** Everything after the code, typically the address the provider now serves. */
  detail: string
}

/** The first word of the body is the code; the rest is provider detail. */
export function parseDyndnsReply(body: string): DyndnsReply {
  const trimmed = body.trim()
  const separator = trimmed.search(/\s/)
  if (separator < 0)
    return { code: trimmed.toLowerCase(), detail: '' }
  return { code: trimmed.slice(0, separator).toLowerCase(), detail: trimmed.slice(separator).trim() }
}

/** Maps a dyndns2 body onto the panel's result shape. */
export function describeDyndnsReply(body: string, provider: string): DdnsResult {
  const { code, detail } = parseDyndnsReply(body)
  const known = CODES[code]
  if (known === undefined)
    return failed(`${provider} answered "${(body.trim() || 'an empty body').slice(0, 120)}"`)
  if (known.ok)
    return succeeded(`${known.message}${detail.length === 0 ? '' : ` (${detail})`}`, known.changed)
  return failed(`${known.message}${detail.length === 0 ? '' : `: ${detail}`}`)
}

/**
 * A 401/400 with a non-dyndns2 body is still an answer worth quoting; a known
 * code wins, because several of these endpoints report errors with HTTP 200.
 */
export function describeDyndnsResponse(response: Response, body: string, provider: string): DdnsResult {
  const { code } = parseDyndnsReply(body)
  if (!response.ok && CODES[code] === undefined) {
    const text = body.replace(/\s+/g, ' ').trim().slice(0, 160)
    return failed(`${provider} answered HTTP ${response.status}${text.length === 0 ? '' : `: ${text}`}`)
  }
  return describeDyndnsReply(body, provider)
}
