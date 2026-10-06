import type { DdnsFetch } from '#src/providers/ddns/types'
import { isIP } from 'node:net'

/**
 * Keyless public-address services. The family-specific hostnames are the point:
 * a bare `ipify.org` answers over whichever family the connection happened to
 * take, which is exactly what an AAAA update must not get.
 */
export const DEFAULT_IPV4_ENDPOINTS = [
  'https://api4.ipify.org',
  'https://ipv4.icanhazip.com',
  'https://checkip.amazonaws.com',
  'https://4.ident.me',
  'https://cloudflare.com/cdn-cgi/trace',
]

export const DEFAULT_IPV6_ENDPOINTS = [
  'https://api6.ipify.org',
  'https://ipv6.icanhazip.com',
  'https://6.ident.me',
  'https://cloudflare.com/cdn-cgi/trace',
]

/** RFC1918, loopback, link-local and CGNAT are never a public DNS target. */
export function isPublicAddress(ip: string, family: 'A' | 'AAAA'): boolean {
  if (family === 'A') {
    const parts = ip.split('.').map(part => Number.parseInt(part, 10))
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255))
      return false
    const [a, b] = parts as [number, number, number, number]
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127))
  }

  const words = ipv6Words(ip)
  if (words === null)
    return false
  const [w0, w1] = words as [number, number, number, number, number, number, number, number]

  // `::` and `::1`.
  if (words.every(word => word === 0) || (w0 === 0 && w1 === 0 && words.slice(2, 7).every(word => word === 0) && words[7] === 1))
    return false
  // `::ffff:0:0/96` (IPv4-mapped) and `::/96` (IPv4-compatible): an IPv4 address in an AAAA slot.
  // The mapped block is where the earlier prefix checks failed — `::ffff:192.168.1.5` passed as
  // "public", so a private address could be published as a AAAA record.
  if (w0 === 0 && w1 === 0 && words[2] === 0 && words[3] === 0 && (words[4] === 0xFFFF || words[4] === 0))
    return false
  // Multicast `ff00::/8`.
  if ((w0 & 0xFF00) === 0xFF00)
    return false
  // Unique local `fc00::/7`, link-local `fe80::/10`.
  if ((w0 & 0xFE00) === 0xFC00 || (w0 & 0xFFC0) === 0xFE80)
    return false
  // Documentation: `2001:db8::/32`, `3fff::/20`.
  if (w0 === 0x2001 && w1 === 0x0DB8)
    return false
  if (w0 === 0x3FFF && (w1 & 0xF000) === 0)
    return false
  // 6to4 `2002::/16`, and the IETF protocol-assignment block `2001::/23` (Teredo, benchmarking,
  // ORCHID) — none of which is an address a host is reached at.
  if (w0 === 0x2002 || (w0 === 0x2001 && w1 <= 0x01FF))
    return false
  // IPv4/IPv6 translation `64:ff9b::/96`.
  if (w0 === 0x0064 && w1 === 0xFF9B)
    return false
  return true
}

/**
 * An IPv6 address as eight 16-bit words, or null when it cannot be parsed.
 *
 * The prefix checks above compare bits, and the same address has many spellings (`::ffff:c000:201`
 * and `::ffff:192.168.1.5` are one address), so a textual `startsWith` is not enough — that is how
 * the mapped block slipped through.
 */
function ipv6Words(ip: string): number[] | null {
  let text = ip.toLowerCase()
  // A trailing dotted quad is the IPv4 form of the last two words.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  if (dotted !== null) {
    const parts = dotted[1]!.split('.').map(part => Number.parseInt(part, 10))
    if (parts.some(part => !Number.isInteger(part) || part < 0 || part > 255))
      return null
    const hi = (((parts[0]! << 8) | parts[1]!) >>> 0).toString(16)
    const lo = (((parts[2]! << 8) | parts[3]!) >>> 0).toString(16)
    text = `${text.slice(0, dotted.index)}${hi}:${lo}`
  }

  const halves = text.split('::')
  if (halves.length > 2)
    return null
  const head = halves[0] === '' ? [] : halves[0]!.split(':')
  const tail = halves.length === 1 || halves[1] === '' ? [] : halves[1]!.split(':')
  // The elided words are zeroes. Built with a push loop rather than `Array.from`/`new Array`: the
  // two lint-preferred spellings disagree with each other and both widen the element type.
  const zeros: string[] = []
  if (halves.length > 1) {
    for (let index = 0; index < 8 - head.length - tail.length; index += 1)
      zeros.push('0')
  }
  const words = halves.length === 1 ? head : [...head, ...zeros, ...tail]
  if (words.length !== 8)
    return null

  const numbers = words.map(word => (/^[0-9a-f]{1,4}$/.test(word) ? Number.parseInt(word, 16) : Number.NaN))
  return numbers.some(number => Number.isNaN(number)) ? null : numbers
}

/**
 * Reads the address out of whatever the endpoint answered: a bare address, a
 * Cloudflare `cdn-cgi/trace` body (`ip=…`), or a small JSON object.
 */
export function parseAddressResponse(text: string, family: 'A' | 'AAAA'): string | null {
  const trimmed = text.trim()
  if (trimmed.length === 0)
    return null

  const candidates: string[] = []
  const trace = /^ip=(.+)$/m.exec(trimmed)?.[1]
  if (trace !== undefined)
    candidates.push(trace.trim())
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      for (const key of ['ip', 'address', 'ip_addr', 'query']) {
        const value = parsed[key]
        if (typeof value === 'string')
          candidates.push(value.trim())
      }
    }
    catch {
      // Not JSON after all; the raw text below is the last chance.
    }
  }
  candidates.push(trimmed)

  const wanted = family === 'A' ? 4 : 6
  for (const candidate of candidates) {
    const value = candidate.split(/[\s,]/)[0] ?? ''
    if (isIP(value) === wanted && isPublicAddress(value, family))
      return value
  }
  return null
}

export interface DetectResult {
  ip: string | null
  error: string | null
}

/**
 * Tries the configured endpoint, or the built-in list in order, and returns the
 * first address that is really public. A transient failure never deletes a
 * record; it just leaves the previous one in place.
 */
export async function detectPublicAddress(
  family: 'A' | 'AAAA',
  overrideUrl: string,
  fetchImpl: DdnsFetch,
  signal?: AbortSignal,
): Promise<DetectResult> {
  const configured = overrideUrl.trim()
  const endpoints = configured.length > 0
    ? [configured]
    : (family === 'A' ? DEFAULT_IPV4_ENDPOINTS : DEFAULT_IPV6_ENDPOINTS)

  let lastError: string | null = null
  for (const endpoint of endpoints) {
    try {
      const response = await fetchImpl(endpoint, { signal, headers: { Accept: 'text/plain, application/json' } })
      if (!response.ok) {
        lastError = `${endpoint} answered ${response.status}`
        continue
      }
      const parsed = parseAddressResponse(await response.text(), family)
      if (parsed !== null)
        return { ip: parsed, error: null }
      lastError = `${endpoint} did not answer with a public ${family === 'A' ? 'IPv4' : 'IPv6'} address`
    }
    catch (error) {
      lastError = `${endpoint}: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  return { ip: null, error: lastError ?? `no endpoint for ${family}` }
}
