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

/** Headers a proxy adds; their presence means the TCP peer is a relay, not the person. */
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-real-ip']

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
