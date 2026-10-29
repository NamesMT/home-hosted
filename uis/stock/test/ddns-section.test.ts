// @vitest-environment happy-dom
import type { DdnsView } from '@shared/contracts'
import type { DraftConfig } from '@shared/ddns-form'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { reactive, ref } from 'vue'
import DdnsSection from '../src/components/settings/DdnsSection.vue'

/**
 * The DDNS section, mounted — because both reported bugs lived in the rendered section.
 *
 * 1. Removing a hostname threw `DataCloneError` from `structuredClone`, and every later edit
 *    stopped publishing a patch: the list `filter` puts Vue proxies inside the raw array, so the
 *    clone of the parent threw. A pure-module test can see the clone; only a mount sees that the
 *    next edit* is dead, which is what a person actually experienced.
 * 2. Any change listed 9 fields, because the page counted the whole block it sends.
 */

const VIEW: DdnsView = {
  config: {
    enabled: true,
    intervalMs: 300_000,
    ttl: 1,
    ipv4: { enabled: true, url: '' },
    ipv6: { enabled: true, url: '' },
    accounts: [{ id: 'main', provider: 'cloudflare', label: '' }],
    domains: [
      { host: 'one.example.com', account: 'main', types: ['A'], proxied: false, enabled: true },
      { host: 'two.example.com', account: 'main', types: ['A'], proxied: false, enabled: true },
    ],
  },
  status: { enabled: true, running: false, lastRunAt: null, lastResult: null, ipv4: null, ipv6: null, records: [] },
  providers: [{
    id: 'cloudflare',
    label: 'Cloudflare',
    docsUrl: 'https://example.com',
    families: ['A', 'AAAA'],
    fields: [{ key: 'apiToken', label: 'API token', hint: '', optional: false }],
    ttl: true,
    proxied: true,
    txt: false,
  }],
  credentials: [],
}

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchDdns: async () => VIEW,
}))

vi.mock('@/composables/useWorkspaces', () => ({
  useWorkspaces: () => ({
    activeId: ref('default'),
    selected: ref({ ddns: VIEW.status }),
  }),
}))

/** The section publishes here; the page's Save reads it. */
function mountSection() {
  // Both models are real refs, as the page holds them: the section writes the baseline it was
  // filled from and the patch its edits produce, and the page's Save reads the patch.
  const patch = ref<PendingConfig>(null)
  const baseline = ref<DraftConfig | null>(null)
  const host = reactive({ patch, baseline })
  const wrapper = mount({
    components: { DdnsSection },
    setup: () => ({ host }),
    template: '<DdnsSection v-model:patch="host.patch" v-model:baseline="host.baseline" />',
  }, {
    global: { stubs: { Modal: { template: '<div><slot /><slot name="footer" /></div>' } } },
  })
  return { wrapper, patch, baseline }
}

type PendingConfig = DdnsView['config'] | null

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('the DDNS section after a hostname is removed', () => {
  it('still publishes a patch for the next edit', async () => {
    const { wrapper, patch } = mountSection()
    await settle()

    const hostValues = (): string[] => wrapper.findAll('input').map(input => (input.element as HTMLInputElement).value)
    expect(hostValues()).toContain('one.example.com')

    // Remove the first hostname — the reported action, and the one that broke the form. Scoped to
    // the row holding it: the accounts list has a Remove of its own, and that one is disabled.
    const row = wrapper.findAll('li').find(node => node.findAll('input').some(input => (input.element as HTMLInputElement).value === 'one.example.com'))
    expect(row, 'the section rendered no row for the first hostname').toBeDefined()
    const remove = row!.findAll('button').find(button => button.text() === 'Remove')
    expect(remove, 'the hostname row has no Remove button').toBeDefined()
    await remove!.trigger('click')
    await settle()

    expect(hostValues(), 'the removed hostname is still on the page').not.toContain('one.example.com')
    expect(patch.value, 'the removal never reached the patch').not.toBeNull()
    expect(patch.value?.domains).toHaveLength(1)

    // The edit that used to be impossible: the section must still react.
    const ipv6 = wrapper.findAll('label').find(node => node.text().startsWith('Detect IPv6'))
    expect(ipv6, 'no "Detect IPv6" label').toBeDefined()
    await ipv6!.trigger('click')
    await settle()

    expect(patch.value, 'the section stopped publishing after a removal').not.toBeNull()
    expect(patch.value?.ipv6.enabled, 'the toggle after a removal never reached the patch').toBe(false)

    wrapper.unmount()
  })
})
