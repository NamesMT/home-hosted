import type { MiddlewareHandler } from 'hono'
import { isIP } from 'node:net'
import { DetailedError } from '@namesmt/utils'
import { isPublicHost } from '#src/shared/proxy-form'

/** The hostname part of a `Host` header: port and IPv6 brackets dropped, lowercased. */
export function hostnameOf(header: string): string {
  let value = header.trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return value.slice(1, end === -1 ? undefined : end)
  }
  const colon = value.lastIndexOf(':')
  // A bare IPv6 literal has several colons and no port.
  if (colon !== -1 && value.indexOf(':') === colon)
    value = value.slice(0, colon)
  return value.replace(/\.$/, '')
}

function matches(hostname: string, pattern: string): boolean {
  const rule = pattern.trim().toLowerCase().replace(/\.$/, '')
  if (rule.startsWith('*.'))
    return hostname.endsWith(rule.slice(1)) && hostname.length > rule.length - 1
  return hostname === rule
}

/**
 * Whether a request's `Host` names this panel rather than an attacker's domain.
 *
 * DNS rebinding points a public name at 127.0.0.1, which makes the attacker's page same-origin with
 * the panel — the `Origin` check cannot see it. An IP literal or a name no public DNS can answer
 * (`localhost`, a single label, `.local`, `.lan`, …) cannot be rebound by a remote site, so those are
 * always allowed; a public name must be one the person declared or a proxy route serving the panel.
 */
export function isAllowedHost(header: string | undefined, allowed: Iterable<string>): boolean {
  if (header === undefined || header.trim() === '')
    return true
  const hostname = hostnameOf(header)
  if (isIP(hostname) !== 0 || !isPublicHost(hostname))
    return true
  for (const pattern of allowed) {
    if (matches(hostname, pattern))
      return true
  }
  return false
}

export function createHostGuard(allowed: () => Iterable<string>): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('host')
    if (!isAllowedHost(header, allowed())) {
      throw new DetailedError(`host "${hostnameOf(header ?? '')}" is not allowed — add it to control.allowedHosts in the panel's settings.json (or reach the panel by IP and add it under Global settings → Listener)`, {
        statusCode: 421,
        code: 'HOST_NOT_ALLOWED',
      })
    }
    await next()
  }
}
