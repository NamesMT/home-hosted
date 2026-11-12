import type { RouteDraft } from '../src/lib/proxy'
import { describe, expect, it } from 'vitest'
import { cloneRoutes, toProxyRoutes } from '../src/lib/proxy'

/**
 * The upstream certificate opt-out, on noc-console's side.
 *
 * `upstreamSkipVerify` is what makes a route to a **self-signed** https backend work: https upstreams
 * are verified unless a route opts out. Both UIs gained a control for it; this pins the contract the
 * control relies on — the field survives the clone a dialog fills its form from, and the wire carries
 * it only when it is set, so a verifying route never tells an older panel about a key it has not got.
 *
 * The stock UI's rendered control is `uis/stock/test/proxy-route-dialog.test.ts`; this file is the
 * data half both UIs share, asserted from the second UI so "the UIs move together" has a check on
 * both sides.
 */
function route(overrides: Partial<RouteDraft> = {}): RouteDraft {
  return {
    key: 'row-1',
    id: 'nas',
    host: 'nas.example.com',
    target: 'external',
    workspace: '',
    server: '',
    url: 'https://10.0.0.5:8443',
    path: '',
    tls: 'off',
    enabled: true,
    dnsAccount: '',
    ...overrides,
  }
}

describe('the upstream verification opt-out in noc-console', () => {
  it('survives the clone the dialog fills its form from', () => {
    const [draft] = cloneRoutes([route({ upstreamSkipVerify: true })])
    expect(draft!.upstreamSkipVerify, 'a clone must keep the opt-out, or Save clears it').toBe(true)
  })

  it('is on the wire only when set', () => {
    expect(toProxyRoutes(cloneRoutes([route({ upstreamSkipVerify: true })]))[0])
      .toMatchObject({ upstreamSkipVerify: true })
    // Absent, not `false`: a route that verifies sends no key at all.
    expect(toProxyRoutes(cloneRoutes([route()]))[0]).not.toHaveProperty('upstreamSkipVerify')
  })
})
