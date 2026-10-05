// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

/**
 * The Logs page's stream filter, driving the real view.
 *
 * Server output interleaves stdout and stderr, so reading one alone is how an operator finds
 * why an entry crashed without the noise around it. `noc-console` had this control and the
 * shipped `stock` UI did not, even though the API, both clients and the schema all supported
 * it — a capability with no way to reach it. The interesting part is the empty value: "All
 * streams" must send the parameter *absent*, because the server reads an empty string as a
 * filter matching nothing.
 */
const pending: Array<{ query?: Record<string, unknown> }> = []

vi.mock('@/lib/api', () => ({
  fetchLogHistory: (_workspace: string, _id: string, query: Record<string, unknown>) => {
    pending.push({ query })
    return Promise.resolve({ lines: [{ ts: 1, stream: 'stderr', text: 'boom' }], searched: null })
  },
  fetchLogServers: async () => [{ serverId: 'web', sizeBytes: 10, files: [{ name: 'web.log', sizeBytes: 10 }] }],
  clearLogs: async () => ({}),
}))
vi.mock('@/composables/useControlPlane', () => ({
  useServerLogs: () => ({ lines: () => [], version: ref(0) }),
  resetLogs: () => {},
  unwatchLogs: () => {},
  watchLogs: () => {},
}))
vi.mock('@/composables/useWorkspaces', () => ({
  useWorkspaces: () => ({
    activeId: ref('default'),
    workspaces: ref([{ id: 'default', label: 'Default' }]),
    selected: ref({ id: 'default', label: 'Default', servers: [] }),
  }),
}))
vi.mock('@/composables/useUi', () => ({ useUi: () => ({}), selectedId: ref(null), flash: () => {} }))
vi.mock('@/composables/useKeymap', () => ({ useKeyHandler: () => {} }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: () => {} }),
  RouterLink: { template: '<a><slot /></a>' },
}))

beforeEach(() => {
  pending.length = 0
})

describe('logs stream filter', () => {
  it('asks for the chosen stream and omits it for all streams', async () => {
    const LogsView = (await import('@/views/LogsView.vue')).default
    const wrapper = mount(LogsView)
    await flushPromises()

    // The first load carries no stream filter.
    expect(pending.at(-1)?.query?.stream, 'the initial load must not filter').toBeUndefined()

    const streamSelect = wrapper.findAll('select').find(node => node.attributes('aria-label') === 'Stream')
    expect(streamSelect, 'the Logs page has no stream filter').toBeDefined()

    await streamSelect!.setValue('stderr')
    await flushPromises()
    expect(pending.at(-1)?.query?.stream).toBe('stderr')

    await streamSelect!.setValue('system')
    await flushPromises()
    expect(pending.at(-1)?.query?.stream).toBe('system')

    // Back to every stream: the key must be gone, not an empty string.
    await streamSelect!.setValue('')
    await flushPromises()
    expect(pending.at(-1)?.query?.stream).toBeUndefined()

    wrapper.unmount()
  })
})
