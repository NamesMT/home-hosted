// @vitest-environment happy-dom
import type { DdnsView } from '@shared/contracts'
import type { DraftConfig } from '@shared/ddns-form'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { reactive, ref } from 'vue'

/**
 * The DDNS draft belongs to one workspace, and the page saves its pending patch into whichever
 * workspace is active at Save. After a switch, the old workspace's patch survived until the new
 * read landed — and for good when that read failed — and a late answer for the old workspace
 * filled the new one's form. Either way Save wrote one workspace's DDNS policy into another.
 */
function view(host: string): DdnsView {
  return {
    config: {
      enabled: true,
      intervalMs: 300_000,
      ttl: 1,
      ipv4: { enabled: true, url: '' },
      ipv6: { enabled: false, url: '' },
      accounts: [{ id: 'main', provider: 'cloudflare', label: '' }],
      domains: [{ host: host as never, account: 'main', types: ['A'], proxied: false, enabled: true }],
    },
    status: { enabled: true, running: false, lastRunAt: null, lastResult: null, ipv4: null, ipv6: null, records: [] },
    providers: [],
    credentials: [],
  }
}

const activeId = ref('alpha')
const pending = new Map<string, { resolve: (value: DdnsView) => void, reject: (error: Error) => void }>()

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchDdns: (id: string) => new Promise<DdnsView>((resolve, reject) => pending.set(id, { resolve, reject })),
}))
vi.mock('@/composables/useWorkspaces', () => ({
  useWorkspaces: () => ({ activeId, selected: ref({ ddns: null }) }),
}))

async function mountSection() {
  const DdnsSection = (await import('../src/components/settings/DdnsSection.vue')).default
  const host = reactive({ patch: null as DdnsView['config'] | null, baseline: null as DraftConfig | null })
  const wrapper = mount({
    components: { DdnsSection },
    setup: () => ({ host }),
    template: '<DdnsSection v-model:patch="host.patch" v-model:baseline="host.baseline" />',
  }, { global: { stubs: { Modal: { template: '<div><slot /><slot name="footer" /></div>' } } } })
  return { wrapper, host }
}

describe('the DDNS draft across a workspace switch', () => {
  it('drops the old workspace\'s patch, and ignores a late answer for it', async () => {
    activeId.value = 'alpha'
    pending.clear()
    const { wrapper, host } = await mountSection()
    pending.get('alpha')!.resolve(view('alpha.example.com'))
    await flushPromises()

    // An edit makes a pending patch for alpha.
    await wrapper.findAll('label').find(node => node.text().startsWith('Detect IPv6'))!.trigger('click')
    await flushPromises()
    expect(host.patch).not.toBeNull()

    // Switch to beta; its read fails.
    activeId.value = 'beta'
    await flushPromises()
    pending.get('beta')!.reject(new Error('panel restarting'))
    await flushPromises()
    expect(host.patch, 'alpha\'s patch must not survive into beta').toBeNull()
    expect(host.baseline).toBeNull()

    // Back and forth again, with alpha's read answering only after the switch to beta.
    activeId.value = 'alpha'
    await flushPromises()
    activeId.value = 'beta'
    await flushPromises()
    pending.get('alpha')!.resolve(view('alpha.example.com'))
    await flushPromises()
    expect(host.baseline, 'a late answer for alpha must not fill beta').toBeNull()
    pending.get('beta')!.resolve(view('beta.example.com'))
    await flushPromises()
    expect(host.baseline?.domains[0]?.host).toBe('beta.example.com')
    wrapper.unmount()
  })
})
