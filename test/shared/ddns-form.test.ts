import type { DdnsConfig } from '#src/shared/contracts'
import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { reactive, ref, toRaw as sharedToRaw } from 'vue'
import { clonePlain } from '#src/shared/clone'
import { ddnsConfigSchema } from '#src/shared/contracts'
import { cloneDdnsConfig, ddnsConfigEquals, ddnsConfigPatch, newDraftDomainKey, requiredDdnsNumber, toDdnsConfig } from '#src/shared/ddns-form'

function config(): DdnsConfig {
  const parsed = ddnsConfigSchema({
    enabled: true,
    accounts: [{ id: 'cf', provider: 'cloudflare', label: 'Home zone' }],
    domains: [{ host: 'home.example.com', account: 'cf', types: ['A', 'AAAA'], proxied: true }],
  })
  if (parsed instanceof type.errors)
    throw parsed
  return parsed as DdnsConfig
}

/** Two hostnames and both families: the shape the settings page was reported on. */
function fullConfig(): DdnsConfig {
  const parsed = ddnsConfigSchema({
    enabled: true,
    intervalMs: 300_000,
    ttl: 1,
    ipv4: { enabled: true, url: '' },
    ipv6: { enabled: true, url: '' },
    accounts: [{ id: 'main', provider: 'cloudflare', label: '' }],
    domains: [
      { host: 'main.example.com', account: 'main', types: ['A', 'AAAA'], proxied: false, enabled: true },
      { host: 'second.example.com', account: 'main', types: ['A'], proxied: false, enabled: true },
    ],
  })
  if (parsed instanceof type.errors)
    throw parsed
  return parsed as DdnsConfig
}

describe('clonePlain', () => {
  it('produces a detached copy', () => {
    const source = { a: { b: [1, 2] } }
    const copy = clonePlain(source)
    copy.a.b.push(3)

    expect(source.a.b).toEqual([1, 2])
    expect(copy).not.toBe(source)
    expect(copy.a).not.toBe(source.a)
  })

  /**
   * The regression: `structuredClone(toRaw(value))` throws on a **nested** proxy, which is what a
   * reactive list holds once the form rebuilt it (`domains = domains.filter(...)`).
   */
  it('copies through a proxy at every level, not just the root', () => {
    const wrapped = reactive({ domains: [{ host: 'a' }, { host: 'b' }] })
    wrapped.domains = wrapped.domains.filter(entry => entry !== wrapped.domains[0])

    // Anti-vacuity: the exact expression the old code used, and it does throw.
    expect(() => structuredClone(sharedToRaw(wrapped))).toThrow(/could not be cloned/)

    const copy = clonePlain(wrapped)
    expect(copy).toEqual({ domains: [{ host: 'b' }] })
    for (const domain of copy.domains)
      expect(() => structuredClone(domain), 'a copied row must be a plain object').not.toThrow()
  })

  it('keeps a Date a Date, and hands back anything non-plain untouched', () => {
    const fn = (): number => 1
    const copy = clonePlain({ at: new Date(1234), fn })
    expect(copy.at).toBeInstanceOf(Date)
    expect(copy.fn).toBe(fn)
  })
})

describe('cloneDdnsConfig', () => {
  /**
   * The regression this exists for: `structuredClone` over a Vue proxy threw `DataCloneError`,
   * which made every later edit unable to publish a patch — and removing a hostname was the
   * reported path, because a `filter` writes the row proxies into the rebuilt array.
   */
  it('clones a config the form holds reactively, list members included', () => {
    const live = reactive(config())
    const cloned = cloneDdnsConfig(live)

    expect(cloned).toMatchObject(config())
    expect(cloned).not.toBe(live)
    expect(cloned.domains).not.toBe(live.domains)
  })

  it('clones a plain config too', () => {
    expect(cloneDdnsConfig(config())).toMatchObject(config())
  })

  it('detaches nested groups, so an edit cannot reach the source', () => {
    const live = reactive(config())
    const cloned = cloneDdnsConfig(live)

    cloned.ipv4.enabled = false
    cloned.domains[0]!.host = 'other.example.com'
    expect(live.ipv4.enabled).toBe(true)
    expect(live.domains[0]!.host).toBe('home.example.com')
  })

  /**
   * The reported flow: the section holds the draft in a `ref`, removing a hostname rebuilds the
   * list, and the next clone threw. `cloneDdnsConfig` must survive its own output becoming live.
   */
  it('clones a draft whose list a removal rebuilt, held the way the section holds it', () => {
    const draft = ref(cloneDdnsConfig(fullConfig()))
    // What `removeDomain` does.
    draft.value.domains = draft.value.domains.filter(entry => entry !== draft.value.domains[0])

    expect(() => structuredClone(sharedToRaw(draft.value)), 'anti-vacuity: the old clone throws').toThrow(/could not be cloned/)

    const clone = cloneDdnsConfig(draft.value)
    expect(clone.domains).toHaveLength(1)
    expect(() => structuredClone(clone), 'the copy must be plain all the way down').not.toThrow()
  })

  it('gives every row a stable key of its own', () => {
    const cloned = cloneDdnsConfig(config())
    expect(cloned.domains[0]!.key).toBeTruthy()
    expect(cloned.domains[0]!.key).not.toBe(cloned.domains[0]!.host)
    expect(newDraftDomainKey()).not.toBe(newDraftDomainKey())
  })
})

describe('toDdnsConfig', () => {
  it('drops the row keys, which the schema rejects', () => {
    const draft = cloneDdnsConfig(config())
    const wire = toDdnsConfig(draft)

    expect(wire).toEqual(config())
    expect(ddnsConfigSchema(wire) instanceof type.errors).toBe(false)
  })

  it('compares the way the server sees it, so a row key is never a change', () => {
    const draft = cloneDdnsConfig(config())
    const withNewKeys = cloneDdnsConfig(config())
    withNewKeys.domains[0]!.key = 'ddns-row-999'

    expect(ddnsConfigEquals(draft, withNewKeys)).toBe(true)

    withNewKeys.domains[0]!.host = 'other.example.com'
    expect(ddnsConfigEquals(draft, withNewKeys)).toBe(false)
  })

  it('treats null as "nothing pending"', () => {
    expect(ddnsConfigEquals(null, null)).toBe(true)
    expect(ddnsConfigEquals(config(), null)).toBe(false)
  })
})

/**
 * The count the settings footer prints. Reporting the whole block listed all nine of its leaves for
 * a single IPv6 toggle, untouched ones included (`true → true` in the change list).
 */
describe('ddnsConfigPatch', () => {
  it('reports one field for a single toggle', () => {
    const baseline = fullConfig()
    const draft = cloneDdnsConfig(baseline)
    draft.ipv6.enabled = false

    expect(ddnsConfigPatch(baseline, draft)).toEqual({ ipv6: { enabled: false } })
  })

  it('reports nothing for a form nobody touched, row keys aside', () => {
    const baseline = fullConfig()
    const draft = cloneDdnsConfig(baseline)
    draft.domains = draft.domains.map(domain => ({ ...domain, key: newDraftDomainKey() }))

    expect(ddnsConfigPatch(baseline, draft)).toBeNull()
  })

  it('reports a replaced list as one field, however many rows it holds', () => {
    const baseline = fullConfig()
    const draft = cloneDdnsConfig(baseline)
    draft.domains = draft.domains.filter(entry => entry !== draft.domains[0])

    const patch = ddnsConfigPatch(baseline, draft)
    expect(Object.keys(patch ?? {})).toEqual(['domains'])
    expect(patch?.domains).toHaveLength(1)
  })

  it('sends only the keys the patch route accepts', () => {
    const baseline = fullConfig()
    const draft = cloneDdnsConfig(baseline)
    draft.ttl = 300
    draft.accounts = [...draft.accounts, { id: 'other', provider: 'namecheap', label: '' }]

    const patch = ddnsConfigPatch(baseline, draft)
    expect(patch).toEqual({ ttl: 300, accounts: [...baseline.accounts, { id: 'other', provider: 'namecheap', label: '' }] })
    // The wire shape, not the draft: no row key may travel.
    expect(JSON.stringify(patch)).not.toContain('ddns-row-')
  })
})

/**
 * `intervalMs` and `ttl` are required by the schema, but a non-nullable `NumberField`
 * reports `NaN` for a cleared box — `JSON.stringify` turns that into `null`, and the panel
 * refused the WHOLE workspace-settings save for it. This is the rule the section's setter
 * applies.
 */
describe('requiredDdnsNumber', () => {
  it('falls back to the schema default for an emptied field', () => {
    expect(requiredDdnsNumber(Number.NaN, 'intervalMs')).toBe(300000)
    expect(requiredDdnsNumber(Number.NaN, 'ttl')).toBe(1)
    expect(requiredDdnsNumber(null, 'ttl')).toBe(1)
  })

  it('keeps a value the person actually typed', () => {
    expect(requiredDdnsNumber(60000, 'intervalMs')).toBe(60000)
    expect(requiredDdnsNumber(3600, 'ttl')).toBe(3600)
  })

  it('produces a body the schema accepts, where null would not', () => {
    // The whole point: a NaN written through becomes `null` in the body, and that is what
    // the panel rejects — taking the entire workspace-settings save with it.
    const valid = { enabled: true, intervalMs: 300000, ttl: requiredDdnsNumber(Number.NaN, 'ttl') }
    expect(JSON.parse(JSON.stringify(valid)).ttl).toBe(1)
    expect(JSON.parse(JSON.stringify({ ...valid, ttl: Number.NaN })).ttl).toBeNull()
  })
})
