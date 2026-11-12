import type { ProxyDnsAccountView } from '@shared/contracts'
import { describe, expect, it } from 'vitest'
import { dnsAccountOptions } from '../src/lib/proxy'

/**
 * The DNS account picker shows which zones an account holds, and marks one with none.
 *
 * `zones` arrived with the change that made "Automatic" use an account **only** for names inside one
 * of them: without it in the picker, an account whose zones do not cover the route read as a normal
 * choice, and a person picked it and then found the challenge had fallen back to HTTP-01 with
 * nothing on the page saying why. An account with no zones covers nothing automatic, which is a fact
 * worth stating where the choice is made.
 *
 * Both UIs share the rule (`uis/stock/src/lib/proxy.ts` and `uis/noc-console/src/lib/proxy.ts` are
 * per-UI because the wording is, the shape is not); this asserts the second one so the pair has a
 * check on each side.
 */
function account(overrides: Partial<ProxyDnsAccountView> = {}): ProxyDnsAccountView {
  return {
    workspace: 'default',
    account: 'cf',
    provider: 'cloudflare',
    label: 'Home zone',
    writesTxt: true,
    hasCredentials: true,
    ...overrides,
  }
}

describe('the DNS account picker', () => {
  it('names the zones an account holds', () => {
    const [, listed] = dnsAccountOptions([account({ zones: ['example.com'] })])
    expect(listed!.label).toContain('example.com')
  })

  it('says so when an account holds none, which makes Automatic skip it', () => {
    const [, listed] = dnsAccountOptions([account({ zones: [] })])
    expect(listed!.label).toContain('no zones')
  })

  /** An older panel sends no `zones` at all; that is not the same as "holds none". */
  it('says nothing when the panel is too old to report zones', () => {
    const [, listed] = dnsAccountOptions([account()])
    expect(listed!.label).not.toContain('no zones')
  })

  it('keeps the picker readable rather than listing a long zone set', () => {
    const many = dnsAccountOptions([account({ zones: ['a.test', 'b.test', 'c.test', 'd.test'] })])
    expect(many[1]!.label).not.toContain('a.test')
  })
})
