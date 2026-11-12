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

    const key = routeKey(route)
    if (seen.has(key))
      errors.push(`"${route.host}" is routed twice`)
    seen.add(key)

    if (route.target === 'server' && (route.workspace.length === 0 || route.server.length === 0))
      errors.push(`route "${route.id}" needs a workspace and a server`)
    if (route.target === 'external' && upstreamTarget(route.url) === null)
      errors.push(`route "${route.id}" needs an upstream like http://10.0.0.5:8080`)

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
