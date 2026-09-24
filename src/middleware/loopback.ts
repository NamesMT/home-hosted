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

export function isLoopbackRequest(c: { req: { raw: unknown } }): boolean {
  return isLoopback(requestIp(c))
}
