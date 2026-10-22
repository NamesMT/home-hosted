/** Minimal cookie helpers, enough for one httpOnly session cookie. */
export interface CookieOptions {
  maxAgeMs?: number
  httpOnly?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  secure?: boolean
  path?: string
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header)
    return cookies
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0)
      continue
    const name = part.slice(0, separator).trim()
    if (name.length === 0)
      continue
    const value = part.slice(separator + 1).trim()
    try {
      cookies[name] = decodeURIComponent(value)
    }
    catch {
      cookies[name] = value
    }
  }
  return cookies
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  parts.push(`Path=${options.path ?? '/'}`)
  if (options.maxAgeMs !== undefined)
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeMs / 1000))}`)
  if (options.httpOnly !== false)
    parts.push('HttpOnly')
  parts.push(`SameSite=${options.sameSite ?? 'Strict'}`)
  if (options.secure)
    parts.push('Secure')
  return parts.join('; ')
}

/**
 * Whether this response's cookie may carry `Secure`, from the configured policy and the protocol the
 * request actually arrived on.
 *
 * One home, because two responses now set the session cookie — the login route and the guard that
 * slides an active session forward. `auto` is the proxy case: behind TLS the panel sees `https:` only
 * because srvx rewrote it from `x-forwarded-proto` (see `.agentDocs/GOTCHAS.md`).
 */
export function secureCookieFor(mode: 'auto' | 'always' | 'never', protocol: string): boolean {
  if (mode === 'always')
    return true
  if (mode === 'never')
    return false
  return protocol === 'https:'
}
