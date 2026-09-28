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

  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::')
    return false
  // fc00::/7 (unique local) and fe80::/10 (link-local).
  return !(lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(lower))
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
