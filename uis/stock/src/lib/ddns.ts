import type { DdnsAccount, DdnsConfig, DdnsDomain } from '@shared/contracts'
import { toRaw } from 'vue'

/**
 * The draft relaxes the two regex-constrained fields — a hostname and an account
 * id are only known to be valid once the whole form is saved, and a text input
 * must be able to hold a half-typed value on the way there.
 */
export type DraftDomain = Omit<DdnsDomain, 'host'> & { host: string }
export type DraftAccount = Omit<DdnsAccount, 'id'> & { id: string }
export type DraftConfig = Omit<DdnsConfig, 'domains' | 'accounts'> & { domains: DraftDomain[], accounts: DraftAccount[] }

/**
 * A detached, plain copy of a config the form may hold reactively.
 *
 * `structuredClone` cannot clone a Vue proxy — it throws `DataCloneError` — and a
 * proxy is exactly what `view.value.config` is once it has been rendered. Cloning
 * the raw target is what makes "Discard" actually replace the draft.
 */
export function cloneDdnsConfig(config: DdnsConfig | DraftConfig): DraftConfig {
  return structuredClone(toRaw(config)) as DraftConfig
}
