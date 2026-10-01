// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RouteTable from '../src/components/proxy/RouteTable.vue'

/**
 * The hostname is a link to where the route really answers. The port comes from the
 * panel's listener, so this guards the wiring rather than the URL shape — a table that
 * forgets to pass it links every route to port 443.
 */

function draft(over: Record<string, unknown> = {}) {
  return {
    key: 'k1',
    id: 'git',
    host: 'git.example.com',
    enabled: true,
    target: 'external',
    workspace: '',
    server: '',
    url: 'http://10.0.0.5:3000',
    path: '',
    tls: 'auto',
    dnsAccount: '',
    ...over,
  } as never
}

function mountTable(routes: unknown[]) {
  return mount(RouteTable, {
    props: { routes: routes as never, views: [], workspaces: [], httpPort: 8080, httpsPort: 4443, disabled: false },
    global: { stubs: { RetryCertificateButton: true, ToneBadge: true, ToggleSwitch: true } },
  })
}

describe('the route table hostname', () => {
  it('opens the route where the engine listens', () => {
    const link = mountTable([draft()]).find('a[href^="https://"]')

    expect(link.attributes('href')).toBe('https://git.example.com:4443')
    expect(link.attributes('target')).toBe('_blank')
    // The list still reads as names: the link is styled like the text it replaces.
    expect(link.text()).toBe('git.example.com')
  })

  it('follows the route to its own port, and to plain HTTP when TLS is off', () => {
    const table = mountTable([
      draft({ key: 'k1', id: 'plain', host: 'plain.example.com', tls: 'off' }),
      draft({ key: 'k2', id: 'std', host: 'std.example.com' }),
    ])

    expect(table.find('a[href="http://plain.example.com:8080"]').exists()).toBe(true)
    expect(table.find('a[href="https://std.example.com:4443"]').exists()).toBe(true)
  })

  it('is plain text for a route that is switched off', () => {
    const table = mountTable([draft({ enabled: false })])

    expect(table.find('a[href]').exists()).toBe(false)
    expect(table.text()).toContain('git.example.com')
  })
})
