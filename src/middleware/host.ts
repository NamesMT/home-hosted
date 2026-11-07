import type { Context, MiddlewareHandler } from 'hono'
import { isIP } from 'node:net'
import { DetailedError } from '@namesmt/utils'
import { isPublicHost } from '#src/shared/proxy-form'

/**
 * The authority a request named, from either protocol.
 *
 * HTTP/2 carries no `Host` header — the name arrives as the `:authority` pseudo-header, which srvx
 * keeps on the underlying node request and filters out of the header bag. Reading only `host` left
 * the guard blind on every TLS listener, so a rebound name reached the app unchecked.
 *
 * Deliberately **not** `new URL(c.req.url).host`: with `trustProxy: 'loopback'` srvx builds that
 * from `X-Forwarded-Host`, which a rebound page sets freely (it is same-origin with the panel, so no
 * preflight stops it) — using it would hand the attacker back the field being checked.
 */
export function requestAuthority(c: Context): string | undefined {
  const host = c.req.header('host')
  if (host !== undefined)
    return host
  const node = (c.req.raw as { runtime?: { node?: { req?: { headers?: Record<string, unknown> } } } }).runtime?.node?.req
  const authority = node?.headers?.[':authority']
  if (typeof authority === 'string')
    return authority
  /**
   * No header and no pseudo-header: take the authority the request was *addressed* with.
   *
   * Only reachable off a real listener in tests (`app.request('/path')` sets neither), because
   * HTTP/1.1 requires `Host` and HTTP/2 requires `:authority`. `c.req.url` is used rather than
   * `requestAuthority`'s caller because srvx derives it from `X-Forwarded-Host` when it trusts the
   * peer — so it is consulted only after both real fields are known to be absent, and a request that
   * spoofs that header still cannot use it to *pass* (the value it names is judged like any other).
   */
  try {
    return new URL(c.req.url).host
  }
  catch {
    return undefined
  }
}

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
 *
 * A request that names no host at all is **refused**: HTTP/1.1 requires `Host`, so its absence means
 * the caller reached us through a channel this guard cannot inspect — and answering `true` there is
 * what turned "no `Host` over HTTP/2" into an open door rather than a closed one.
 */
export function isAllowedHost(header: string | undefined, allowed: Iterable<string>): boolean {
  if (header === undefined || header.trim() === '')
    return false
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
    const authority = requestAuthority(c)
    if (!isAllowedHost(authority, allowed())) {
      const named = authority === undefined || authority.trim() === '' ? 'no host' : `host "${hostnameOf(authority)}"`
      throw new DetailedError(`${named} is not allowed — add it to control.allowedHosts in the panel's settings.json (or reach the panel by IP and add it under Global settings → Listener)`, {
        statusCode: 421,
        code: 'HOST_NOT_ALLOWED',
      })
    }
    await next()
  }
}
