// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import SideNav from '../src/components/shell/SideNav.vue'

/**
 * The sidebar is where the running panel version lives, and it has to keep working
 * against a panel that predates the field: `null` falls back to the panel's name
 * rather than printing "vnull" or blanking the line.
 */

async function mountNav(panelVersion: string | null) {
  const router = createRouter({
    history: createMemoryHistory(),
    // Every link the nav renders, so the router does not warn about the four of them.
    routes: ['/', '/servers', '/logs', '/settings'].map(path => ({ path, component: { template: '<div />' } })),
  })
  await router.push('/')
  await router.isReady()

  return mount(SideNav, {
    props: {
      host: null,
      connection: 'open',
      panelLabel: 'home-hosted',
      panelVersion,
      planLabel: 'http://127.0.0.1:3999',
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

describe('side nav', () => {
  it('shows the release the panel is running', async () => {
    expect(versionLine(await mountNav('0.6.5'))).toBe('home-hosted · v0.6.5')
  })

  it('falls back to the panel name when the panel does not report one', async () => {
    const wrapper = await mountNav(null)
    expect(versionLine(wrapper)).toBe('home-hosted')
    expect(wrapper.text()).not.toContain('vnull')
  })
})
