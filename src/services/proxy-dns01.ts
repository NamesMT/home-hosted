import type { ProxyUpstreamRoute } from '#src/services/proxy-config'
import { isPublicHost } from '#src/shared/proxy-form'

/**
 * The engine policies DNS-01 needs: one per account, because a policy carries one
 * challenge provider. Names that no account answers are left out, and the caller
 * renders them on the port challenges as before.
 *
 * Pure so the grouping can be checked without an engine: getting it wrong means a
 * hostname is asked for through the wrong zone, which fails with nothing to read.
 */
export function groupDns01Policies(
  routes: readonly ProxyUpstreamRoute[],
  accountFor: (host: string) => { workspaceId: string, accountId: string, provider: string } | null,
): Array<{ account: string, provider: string, subjects: string[] }> {
  const byAccount = new Map<string, { provider: string, subjects: string[] }>()
  for (const route of routes) {
    // Only names a CA could issue for: a loopback address or a `.lan` name belongs to
    // the engine's own CA, and listing it here made Caddy try ACME for an IP.
    if (route.tls !== 'auto' || !isPublicHost(route.host))
      continue
    const account = accountFor(route.host)
    if (account === null)
      continue
    const key = `${account.workspaceId}/${account.accountId}`
    const existing = byAccount.get(key)
    if (existing === undefined)
      byAccount.set(key, { provider: account.provider, subjects: [route.host] })
    else if (!existing.subjects.includes(route.host))
      existing.subjects.push(route.host)
  }
  return [...byAccount.entries()].map(([account, group]) => ({ account, provider: group.provider, subjects: group.subjects }))
}
