// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

/**
 * A tail request has no token, so whichever answer lands *last* wins. Picking another
 * server while the first request is still in flight therefore left the header naming the
 * new server and the viewer showing the old one's lines.
 *
 * This drives the real view with a deferred `fetchLogHistory`, because the defect is
 * entirely in the ordering — no pure module can see it.
 */
const pending: Array<{ id: string, resolve: (value: unknown) => void }> = []
const selectedId = ref<string | null>('alpha')

vi.mock('@/lib/api', () => ({
  fetchLogHistory: (id: string) => new Promise((resolve) => { pending.push({ id, resolve }) }),
  listLogServers: async () => [{ serverId: 'alpha' }, { serverId: 'beta' }],
  clearLogs: async () => ({}),
}))
vi.mock('@/composables/useControlPlane', () => ({ resetLogs: () => {}, unwatchLogs: () => {}, watchLogs: () => {} }))
vi.mock('@/composables/useUi', () => ({ selectedId, flash: () => {}, useUi: () => ({ selectedId }) }))
vi.mock('@/composables/useKeymap', () => ({ useKeyHandler: () => {} }))
vi.mock('@/composables/useWorkspaces', () => ({
  useWorkspaces: () => ({
    activeId: ref('default'),
    workspaces: ref([]),
    selected: ref({ id: 'default', servers: [] }),
    serversOf: () => [],
  }),
}))

const history = (text: string) => ({ lines: [{ ts: 1, stream: 'stdout', text }], searched: 1, total: 1 })

beforeEach(() => {
  pending.length = 0
  selectedId.value = 'alpha'
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('logTail responses', () => {
  it('ignores a slower answer for the server the person already left', async () => {
    const LogsView = (await import('@/views/LogsView.vue')).default
    const wrapper = mount(LogsView)
    await flushPromises()
    await nextTick()

    // Move to beta while alpha's request is still outstanding.
    selectedId.value = 'beta'
    await flushPromises()
    await nextTick()

    const alpha = pending.find(entry => entry.id === 'alpha')
    const beta = pending.find(entry => entry.id === 'beta')
    expect(alpha, 'alpha request never started').toBeDefined()
    expect(beta, 'beta request never started').toBeDefined()

    // Beta answers first, then alpha's stale answer arrives.
    beta!.resolve(history('beta-line'))
    await flushPromises()
    await nextTick()
    alpha!.resolve(history('alpha-line'))
    await flushPromises()
    await nextTick()

    // The viewer must still show beta's lines.
    expect(wrapper.text()).toContain('beta-line')
    expect(wrapper.text()).not.toContain('alpha-line')

    wrapper.unmount()
  })
})
