import type { DdnsConfig } from '@shared/contracts'
import { ddnsConfigSchema } from '@shared/contracts'
import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import { cloneDdnsConfig } from '@/lib/ddns'

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

describe('cloneDdnsConfig', () => {
  /**
   * The regression this exists for: `structuredClone` over a Vue proxy throws
   * `DataCloneError`, which made Discard a no-op with an error only in the console.
   */
  it('clones a config the form holds reactively', () => {
    const live = reactive(config())
    const cloned = cloneDdnsConfig(live)

    expect(cloned).toEqual(config())
    expect(cloned).not.toBe(live)
    expect(cloned.domains).not.toBe(live.domains)
  })

  it('clones a plain config too', () => {
    expect(cloneDdnsConfig(config())).toEqual(config())
  })

  it('detaches nested groups, so an edit cannot reach the source', () => {
    const live = reactive(config())
    const cloned = cloneDdnsConfig(live)

    cloned.ipv4.enabled = false
    cloned.domains[0]!.host = 'other.example.com'
    expect(live.ipv4.enabled).toBe(true)
    expect(live.domains[0]!.host).toBe('home.example.com')
  })
})
