import type { DdnsProvider } from '#src/providers/ddns/types'
import type { DdnsConfig, DdnsProviderInfo } from '#src/shared/contracts'
import { cloudflareProvider } from '#src/providers/ddns/cloudflare'
import { desecProvider } from '#src/providers/ddns/desec'
import { digitaloceanProvider } from '#src/providers/ddns/digitalocean'
import { duckdnsProvider } from '#src/providers/ddns/duckdns'
import { dynuProvider } from '#src/providers/ddns/dynu'
import { freednsProvider } from '#src/providers/ddns/freedns'
import { gandiProvider } from '#src/providers/ddns/gandi'
import { godaddyProvider } from '#src/providers/ddns/godaddy'
import { henetProvider } from '#src/providers/ddns/henet'
import { namecheapProvider } from '#src/providers/ddns/namecheap'
import { namecheapApiProvider } from '#src/providers/ddns/namecheap-api'
import { noipProvider } from '#src/providers/ddns/noip'
import { porkbunProvider } from '#src/providers/ddns/porkbun'
import { spaceshipProvider } from '#src/providers/ddns/spaceship'

/** Registry order is what the settings page offers. */
export const DDNS_PROVIDERS: readonly DdnsProvider[] = [
  cloudflareProvider,
  namecheapProvider,
  namecheapApiProvider,
  spaceshipProvider,
  porkbunProvider,
  godaddyProvider,
  gandiProvider,
  digitaloceanProvider,
  desecProvider,
  duckdnsProvider,
  noipProvider,
  dynuProvider,
  henetProvider,
  freednsProvider,
]

const BY_ID = new Map(DDNS_PROVIDERS.map(provider => [provider.id, provider]))

export function ddnsProvider(id: string): DdnsProvider | null {
  return BY_ID.get(id) ?? null
}

export function ddnsProviderInfos(): DdnsProviderInfo[] {
  return DDNS_PROVIDERS.map(provider => ({
    id: provider.id,
    label: provider.label,
    docsUrl: provider.docsUrl,
    families: provider.families,
    fields: provider.fields,
    ttl: provider.ttl,
    proxied: provider.proxied,
    txt: provider.challenge !== undefined,
  }))
}

/**
 * Cross-field problems ArkType cannot see. Credentials are deliberately not
 * required here: an account is normally added before its secret is typed in,
 * and a missing secret is reported per record instead of blocking the save.
 */
export function validateDdnsConfig(config: DdnsConfig): string[] {
  const errors: string[] = []
  const seenAccounts = new Set<string>()
  for (const account of config.accounts) {
    if (seenAccounts.has(account.id)) {
      errors.push(`account "${account.id}" is declared twice`)
      continue
    }
    seenAccounts.add(account.id)
    if (ddnsProvider(account.provider) === null)
      errors.push(`account "${account.id}" uses an unknown provider "${account.provider}"`)
  }

  const seenRecords = new Set<string>()
  for (const domain of config.domains) {
    const account = config.accounts.find(entry => entry.id === domain.account)
    if (account === undefined) {
      errors.push(`"${domain.host}" points at unknown account "${domain.account}"`)
      continue
    }
    // A `zone` is a short-circuit for the split heuristic, so one that does not contain the host makes
    // `splitHost` return the **whole** fqdn as the record name — GoDaddy was then asked for
    // `exmple.com/records/A/home.example.com`, a domain that is not the user's, and reported success.
    const zone = domain.zone?.trim().toLowerCase()
    if (zone !== undefined && zone.length > 0 && domain.host.toLowerCase() !== zone && !domain.host.toLowerCase().endsWith(`.${zone}`))
      errors.push(`"${domain.host}" has zone "${domain.zone}", which it is not inside — a zone is the registered domain the record lives in`)

    const provider = ddnsProvider(account.provider)
    if (provider !== null) {
      for (const recordType of domain.types) {
        if (!provider.families.includes(recordType))
          errors.push(`${account.label || provider.label} cannot manage ${recordType} records ("${domain.host}")`)
        const key = `${domain.host.toLowerCase()}|${recordType}`
        if (seenRecords.has(key))
          errors.push(`"${domain.host}" asks for ${recordType} twice`)
        seenRecords.add(key)
      }
    }
  }

  return errors
}
