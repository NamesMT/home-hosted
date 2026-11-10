import type { DdnsAccount, DdnsConfig, DdnsDomain, DdnsPatch } from './contracts'
import { clonePlain } from './clone'
import { diffFields } from './patch-diff'

/**
 * The DDNS form both UIs edit: the draft its rows are held in, the wire shape a save sends,
 * and the diff the page's change list counts.
 *
 * It lives here because the two UIs' copies had already diverged (`noc-console` repaired an
 * emptied box where `stock` fell back to a default) and both needed the same two fixes.
 */

/**
 * The draft relaxes the two regex-constrained fields, and gives every hostname row a stable key.
 * Keying the rows on `host` re-created the row on each keystroke, which threw the caret out of the
 * input after every character.
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
 * `structuredClone(toRaw(config))` does **not** detach it: a list the form rebuilt
 * (`domains = domains.filter(...)`) holds Vue proxies inside the raw array, so the clone threw
 * `DataCloneError` and every later edit stopped publishing a patch. See `clonePlain`.
 */
export function cloneDdnsConfig(config: DdnsConfig | DraftConfig): DraftConfig {
  const clone = clonePlain(config) as DraftConfig
  // `domains` is required by the schema, so there is no absent case to fall back for.
  clone.domains = clone.domains.map(domain => ({ ...domain, key: (domain as DraftDomain).key ?? newDraftKey() }))
  return clone
}

/** The wire shape: a row key is a UI detail, and the schema rejects undeclared keys. */
export function toDdnsConfig(draft: DraftConfig | DdnsConfig): DdnsConfig {
  const clone = clonePlain(draft) as DraftConfig
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

/**
 * What this form actually moved, in the wire shape.
 *
 * `ipv4`/`ipv6` are left to `diffFields`' nested diff, so they report the one member that changed;
 * `accounts`/`domains` are leaves of their own, because the route **replaces** both lists — one
 * edited hostname is one changed field however many rows the list holds.
 *
 * Counting the whole block instead listed all nine of its leaves for a single IPv6 toggle, and
 * showed the untouched ones as `true → true`.
 */
export function ddnsConfigPatch(baseline: DdnsConfig | DraftConfig, draft: DdnsConfig | DraftConfig): DdnsPatch | null {
  const patch = diffFields(
    toDdnsConfig(baseline) as unknown as Record<string, unknown>,
    toDdnsConfig(draft) as unknown as Record<string, unknown>,
    ['ipv4', 'ipv6'],
  )
  return Object.keys(patch).length === 0 ? null : patch as DdnsPatch
}

/** The schema's own defaults for the two required numbers, in one place. */
export const DDNS_DEFAULTS = { intervalMs: 300000, ttl: 1 } as const

/**
 * Which value a required DDNS number should actually hold.
 *
 * A cleared box reports `NaN` (or `null`), and `JSON.stringify` turns that into `null` — which
 * `ddnsConfigSchema` rejects, refusing the whole workspace-settings save rather than that one
 * field. Fall back to the schema's default; the panel would have applied it anyway.
 */
export function requiredDdnsNumber(value: number | null, key: keyof typeof DDNS_DEFAULTS): number {
  return value === null || Number.isNaN(value) ? DDNS_DEFAULTS[key] : value
}

/**
 * Which DDNS answers still belong on screen.
 *
 * The draft is per workspace, and its pending patch is saved by the page into whichever workspace
 * is active **then**. A read for the previous workspace that answered after a switch filled the new
 * one's form with the old policy, and a switch whose read failed kept the old patch — so Save wrote
 * one workspace's DDNS policy into another. A full read is the latest of its kind or it is dropped;
 * an action's answer (a pass, a credential change) is kept only while its workspace is still shown.
 */
export function createDdnsReads(active: () => string): { load: () => () => boolean, action: () => () => boolean } {
  let generation = 0
  return {
    load: () => {
      const mine = ++generation
      const id = active()
      return () => mine === generation && id === active()
    },
    action: () => {
      const id = active()
      return () => id === active()
    },
  }
}
