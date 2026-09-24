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
