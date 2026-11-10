/** Client address helpers shared by the auth guard and the setup routes. */

export function requestIp(c: { req: { raw: unknown } }): string | null {
  // srvx resolves this hop-aware from `trustProxy` + x-forwarded-for.
  const raw = c.req.raw as { ip?: string } | undefined
  return raw?.ip ?? null
}

export function isLoopback(address: string | null): boolean {
  if (!address)
    return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Headers a proxy adds; their presence means the TCP peer is a relay, not the person.
 *
 * This is a **heuristic, not a guarantee**, and the docs say so: a proxy that forwards the request
 * and strips every one of these is indistinguishable from a local client, which is unavoidable — the
 * panel's own engine is exactly such a loopback peer. What it can do is fail closed on the
 * misconfigurations people actually write: a minimal nginx very often forwards only
 * `Proxy_Set_Header X-Forwarded-Proto` (or `Host`/the original port when it rewrites them), so the
 * `x-forwarded-*` family is listed whole rather than only the address-valued ones. A relay that adds
 * any* of them is then not "this machine", instead of handing the internet local trust.
 */
const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-real-ip',
  // Not address-valued, and that is the point: a proxy that forwards only one of these used to read
  // as a direct local client. `x-forwarded-host` is also what srvx derives the request URL from when
  // it trusts the peer, so noticing it here is the same fact the host guard already relies on.
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-prefix',
]

/**
 * Whether the request was made on this machine, by something that did not relay it.
 *
 * The panel's own reverse proxy connects from 127.0.0.1, so a loopback peer alone would hand every
 * internet client this machine's trust (the "no password set yet" pass, first-setup, `/_hh`).
 */
export function isLoopbackRequest(c: { req: { raw: unknown } }): boolean {
  const headers = (c.req.raw as { headers?: Headers } | undefined)?.headers
  if (headers !== undefined && FORWARDING_HEADERS.some(name => headers.has(name)))
    return false
  return isLoopback(requestIp(c))
}
