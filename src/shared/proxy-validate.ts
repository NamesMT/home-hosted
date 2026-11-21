import type { ProxyConfig } from './contracts'
import { isPublicHost, routeKey, upstreamTarget } from './proxy-form'

/** What a route's `dnsAccount` resolves to, for the save-time check. */
export interface DnsAccountCheck {
  provider: string
  /** The provider can write a TXT record, which is the only thing a challenge needs. */
  writesTxt: boolean
  /** Credentials are stored for the account. */
  hasCredentials: boolean
}

/** Cross-field problems ArkType cannot see, reported by the API before a save. */
export function validateProxyConfig(config: ProxyConfig, dnsAccount?: (ref: string, workspaceId: string) => DnsAccountCheck | null): string[] {
  const errors: string[] = []
  if (config.httpPort === config.httpsPort)
    errors.push('the http and https ports must differ')

  const advertised = new Set(config.routes.filter(route => route.tls !== 'off').map(route => route.host.toLowerCase()))
  const publicNames = [...advertised].filter(host => isPublicHost(host))
  if (publicNames.length > 0 && config.email.trim().length === 0 && !config.staging)
    errors.push(`automatic HTTPS needs an ACME account e-mail for ${publicNames.join(', ')}`)

  const seen = new Set<string>()
  const ids = new Set<string>()
  for (const route of config.routes) {
    if (ids.has(route.id))
      errors.push(`route id "${route.id}" is used twice`)
    ids.add(route.id)

    /**
     * A hostname longer than 253 characters cannot resolve, so accepting one stores a route that can
     * never work — and `renderCaddyConfig` passes it straight to the engine.
     *
     * Found by driving it: a 5004-character host was accepted `200` by `PATCH /api/proxy` and stored
     * intact. The schema's pattern has no length bound (only the shape), and nothing else checked.
     * The limit is DNS's own — 253 octets for a name, 63 for one label — so a longer route is not a
     * policy choice, it is a route that cannot exist.
     */
    if (route.host.length > 253)
      errors.push(`"${route.host.slice(0, 40)}…" is ${route.host.length} characters; a hostname cannot exceed 253`)
    else if (route.host.split('.').some(label => label.length > 63))
      errors.push(`"${route.host}" has a label longer than 63 characters`)

    const key = routeKey(route)
    if (seen.has(key))
      errors.push(`"${route.host}" is routed twice`)
    seen.add(key)

    if (route.target === 'server' && (route.workspace.length === 0 || route.server.length === 0))
      errors.push(`route "${route.id}" needs a workspace and a server`)
    if (route.target === 'external' && upstreamTarget(route.url) === null) {
      /**
       * An **empty** upstream and a malformed one are different problems, and the message said only the
       * first. `http://<304 characters>:8080` is present, parseable to a human, and refused — answering
       * "needs an upstream" for it sends someone to type a URL they already typed.
       */
      errors.push(route.url.trim().length === 0
        ? `route "${route.id}" needs an upstream like http://10.0.0.5:8080`
        : `route "${route.id}" has an upstream this panel cannot use: "${route.url.slice(0, 60)}" — an http(s) host and port, at most 253 characters`)
    }

    // A named account has to be able to do the one thing it is named for. Catching it
    // here beats a challenge that fails weeks later with nothing to read.
    const named = route.dnsAccount.trim()
    if (named.length === 0 || dnsAccount === undefined)
      continue
    if (!config.dns01.enabled)
      errors.push(`route "${route.id}" names DNS account "${named}", but DNS-01 is switched off`)
    // The route's own workspace, which is where the challenge path looks it up too.
    const found = dnsAccount(named, route.workspace)
    if (found === null)
      errors.push(`route "${route.id}" names unknown DNS account "${named}"`)
    else if (!found.writesTxt)
      errors.push(`route "${route.id}": the "${found.provider}" account cannot write TXT records, so it cannot answer a DNS-01 challenge`)
    else if (!found.hasCredentials)
      errors.push(`route "${route.id}": the "${found.provider}" account has no credentials stored yet`)
  }
  return errors
}
