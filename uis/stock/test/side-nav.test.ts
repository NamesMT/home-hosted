// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import SideNav from '../src/components/shell/SideNav.vue'

/**
 * The sidebar is where the running panel version lives, and it has to keep working
 * against a panel that predates the field: `null` falls back to the panel's name
 * rather than printing "vnull" or blanking the line.
 *
 * It also names the workspace its entries belong to, keeps the workspace and
 * panel-wide pages in two groups, and puts the workspace id in every link so a
 * page can be bookmarked.
 */

/** Every link the nav renders, so the router does not warn about any of them. */
const PATHS = ['/w/acme', '/w/acme/servers', '/w/acme/logs', '/w/acme/settings', '/global/overview', '/global/settings']

async function mountNav(panelVersion: string | null, path = '/w/acme') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: PATHS.map(route => ({ path: route, component: { template: '<div />' } })),
  })
  await router.push(path)
  await router.isReady()

  return mount(SideNav, {
    props: {
      host: null,
      connection: 'open',
      panelLabel: 'home-hosted',
      panelVersion,
      planLabel: 'http://127.0.0.1:3999',
      workspaceId: 'acme',
      workspaceLabel: 'acme',
      running: 1,
      total: 2,
    },
    global: { plugins: [router] },
  })
}

/** The version line is the sidebar's only `<p>` carrying a `title`. */
function versionLine(wrapper: Awaited<ReturnType<typeof mountNav>>): string {
  return wrapper.get('p[title]').text()
}

/** The active entry is the one wearing the accent fill (`isActive` in SideNav). */
function isActive(wrapper: Awaited<ReturnType<typeof mountNav>>, label: string): boolean {
  const link = wrapper.findAll('a').find(node => node.text().includes(label))
  if (!link)
    throw new Error(`no nav link for ${label}`)
  return link.classes().includes('bg-accent-soft')
}

function hrefOf(wrapper: Awaited<ReturnType<typeof mountNav>>, label: string): string {
  const link = wrapper.findAll('a').find(node => node.text().includes(label))
  if (!link)
    throw new Error(`no nav link for ${label}`)
  return link.attributes('href') ?? ''
}

describe('side nav', () => {
  it('shows the release the panel is running', async () => {
    expect(versionLine(await mountNav('0.6.5'))).toBe('home-hosted · v0.6.5')
  })

  it('falls back to the panel name when the panel does not report one', async () => {
    const wrapper = await mountNav(null)
    expect(versionLine(wrapper)).toBe('home-hosted')
    expect(wrapper.text()).not.toContain('vnull')
  })

  it('names the workspace group and keeps the panel-wide pages separate', async () => {
    const wrapper = await mountNav('0.6.5')

    expect(wrapper.text()).toContain('Workspace · acme')
    expect(wrapper.text()).toContain('Global')

    for (const label of ['Overview', 'Servers', 'Logs', 'Workspace settings', 'Global Overview', 'Global settings'])
      expect(wrapper.findAll('a').some(node => node.text().includes(label)), label).toBe(true)

    // The Servers entry carries the running/total badge.
    expect(wrapper.findAll('a').find(node => node.text().includes('Servers'))!.text()).toContain('1/2')
  })

  it('puts the workspace id in every workspace-scoped link', async () => {
    const wrapper = await mountNav('0.6.5')

    expect(hrefOf(wrapper, 'Overview')).toBe('/w/acme')
    expect(hrefOf(wrapper, 'Servers')).toBe('/w/acme/servers')
    expect(hrefOf(wrapper, 'Logs')).toBe('/w/acme/logs')
    expect(hrefOf(wrapper, 'Workspace settings')).toBe('/w/acme/settings')
    // The panel-wide pages are not workspace-scoped.
    expect(hrefOf(wrapper, 'Global Overview')).toBe('/global/overview')
    expect(hrefOf(wrapper, 'Global settings')).toBe('/global/settings')
  })

  /**
   * The workspace Overview lives at `/w/<id>`, so a plain prefix match would light
   * it up on every page under it — and on `/global/overview` it and the Global
   * Overview would both be lit. Both are exact matches; only the page actually
   * shown may be active.
   */
  it('matches the workspace Overview exactly, not as a prefix', async () => {
    expect(isActive(await mountNav('0.6.5', '/w/acme'), 'Overview')).toBe(true)
    expect(isActive(await mountNav('0.6.5', '/w/acme/servers'), 'Overview')).toBe(false)
    expect(isActive(await mountNav('0.6.5', '/w/acme/servers'), 'Servers')).toBe(true)
    expect(isActive(await mountNav('0.6.5', '/global/overview'), 'Overview')).toBe(false)
  })

  it('lights exactly one group on the global overview', async () => {
    const wrapper = await mountNav('0.6.5', '/global/overview')

    expect(isActive(wrapper, 'Global Overview')).toBe(true)
    expect(isActive(wrapper, 'Overview')).toBe(false)
    // Global settings keeps its nested pages active, so it is not exact.
    expect(isActive(wrapper, 'Global settings')).toBe(false)
  })
})
