// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { router } from '../src/router'

/**
 * Every view was imported eagerly, so the entry chunk carried every settings form and editor
 * (~960 KB raw). The heavier pages load on first visit; the first paint stays eager.
 */
describe('the stock routes', () => {
  const component = (name: string): unknown => router.getRoutes().find(route => route.name === name)?.components?.default

  it('loads the heavier pages on demand', () => {
    for (const name of ['server-detail', 'logs', 'settings', 'global-settings', 'proxy'])
      expect(typeof component(name), name).toBe('function')
  })

  it('keeps login and the overviews in the entry chunk', () => {
    for (const name of ['login', 'overview', 'global-overview', 'home'])
      expect(typeof component(name), name).toBe('object')
  })
})
