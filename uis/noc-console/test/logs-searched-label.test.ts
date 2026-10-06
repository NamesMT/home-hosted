// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'

/**
 * "searched n lines" describes the last *disk* search, and must not outlive it.
 *
 * The tail, stream and search controls are all `disabled` in live mode because they apply only
 * to the persisted window — but the label had no such guard, so it stayed on screen in live mode
 * describing a filter that was not active, and returning to disk could show a count from a
 * request that was no longer the current one.
 */
const pending: Array<{ resolve: (value: unknown) => void }> = []
const selectedId = ref<string | null>('alpha')

/**
 * `activeId` is a *computed* over the workspace list in the real composable, and the view watches
 * it — so a mock that returns a plain ref which changes identity wipes the server list and there
 * is nothing left to render. Modelled as the real one derives it.
 */
const workspaces = ref([{ id: 'default', label: 'Default', servers: [] }])
const selectedWorkspaceId = ref('default')

vi.mock('@/lib/api', () => ({
  fetchLogHistory: () => new Promise((resolve) => { pending.push({ resolve }) }),
  // `enabled: false` keeps the header's download link out of the tree. That link reads
  // `api.logDownloadUrl` off the mocked module namespace, and Vue's ref-unwrapping throws on a
  // mock object ("No __v_isRef export is defined on the @/lib/api mock") — aborting the render
  // before the sidebar exists. The download link is not what this test is about.
  fetchLogServers: async () => [{
    serverId: 'alpha',
    label: 'alpha',
    status: 'running',
    enabled: false,
    sizeBytes: 10,
    files: [],
  }],
  clearLogs: async () => ({}),
}))
vi.mock('@/composables/useControlPlane', () => ({
  resetLogs: () => {},
  unwatchLogs: () => {},
  watchLogs: () => [],
}))
vi.mock('@/composables/useUi', () => ({ selectedId, flash: () => {}, useUi: () => ({ selectedId }) }))
vi.mock('@/composables/useKeymap', () => ({ useKeyHandler: () => {} }))
vi.mock('@/composables/useWorkspaces', () => ({
  useWorkspaces: () => ({
    activeId: computed(() => selectedWorkspaceId.value),
    workspaces,
    selected: computed(() => workspaces.value.find(w => w.id === selectedWorkspaceId.value) ?? null),
    serversOf: () => [],
  }),
}))

beforeEach(() => {
  pending.length = 0
  selectedId.value = 'alpha'
})

describe('the searched label', () => {
  it('shows in disk mode, and is gone in live mode', async () => {
    const LogsView = (await import('@/views/LogsView.vue')).default
    const wrapper = mount(LogsView)
    await flushPromises()

    expect(pending.length, 'no log request was made').toBeGreaterThan(0)
    for (const entry of pending.splice(0))
      entry.resolve({ lines: [{ ts: 1, stream: 'stdout', text: 'hit' }], searched: 5000 })
    await flushPromises()
    expect(wrapper.text(), 'disk mode should report how much was searched').toContain('searched 5000 lines')

    // Switch to live: the search box is disabled there, so its label must go too.
    const source = wrapper.findAll('select').find(node => node.attributes('title') === 'source')
    expect(source, 'no source control').toBeDefined()
    await source!.setValue('live')
    await flushPromises()
    expect(wrapper.text(), 'live mode must not claim a search it is not doing').not.toContain('searched')

    wrapper.unmount()
  })
})
