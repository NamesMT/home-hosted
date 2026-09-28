import type { DdnsAccount, DdnsConfig, DdnsDomain } from '@shared/contracts'
import { toRaw } from 'vue'

/**
 * The draft relaxes the two regex-constrained fields, and gives every hostname row
 * a stable key. Keying the rows on `host` re-created the row on each keystroke,
 * which threw the caret out of the input after every character.
 */
export type DraftDomain = Omit<DdnsDomain, 'host'> & { host: string, key: string }
export type DraftAccount = Omit<DdnsAccount, 'id'> & { id: string }
export type DraftConfig = Omit<DdnsConfig, 'domains' | 'accounts'> & { domains: DraftDomain[], accounts: DraftAccount[] }

let counter = 0

function newDraftKey(): string {
  counter += 1
  return `ddns-row-${counter}`
}

/** One stable identity for a row the person just added. */
export function newDraftDomainKey(): string {
  return newDraftKey()
}

/**
 * A detached, plain copy of a config the form may hold reactively.
 *
 * `structuredClone` cannot clone a Vue proxy — it throws `DataCloneError` — and a
 * proxy is exactly what `view.value.config` is once it has been rendered.
 */
export function cloneDdnsConfig(config: DdnsConfig | DraftConfig): DraftConfig {
  const clone = structuredClone(toRaw(config)) as DraftConfig
  clone.domains = (clone.domains ?? []).map(domain => ({ ...domain, key: (domain as DraftDomain).key ?? newDraftKey() }))
  return clone
}

/** The wire shape: a row key is a UI detail, and the schema rejects undeclared keys. */
export function toDdnsConfig(draft: DraftConfig | DdnsConfig): DdnsConfig {
  const clone = structuredClone(toRaw(draft)) as DraftConfig
  return {
    ...clone,
    domains: clone.domains.map(({ key: _key, ...domain }) => domain),
  } as unknown as DdnsConfig
}

/** Compares two blocks the way the server sees them, ignoring row keys. */
export function ddnsConfigEquals(a: DdnsConfig | DraftConfig | null, b: DdnsConfig | DraftConfig | null): boolean {
  if (a === null || b === null)
    return a === b
  return JSON.stringify(toDdnsConfig(a)) === JSON.stringify(toDdnsConfig(b))
}
