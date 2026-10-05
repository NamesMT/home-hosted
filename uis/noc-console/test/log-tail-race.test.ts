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
const pending: Array<{ id: string, query?: Record<string, unknown>, resolve: (value: unknown) => void }> = []
const selectedId = ref<string | null>('alpha')

vi.mock('@/lib/api', () => ({
  fetchLogHistory: (id: string, query: Record<string, unknown>) => new Promise((resolve) => { pending.push({ id, query, resolve }) }),
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

/**
 * The disk-mode filter controls: the stream select and the debounced search.
 *
 * These are the two things that decide *which* lines the server is asked for, and neither was
 * pinned. The stream select matters in particular: it sends `stream=stderr`, and the server
 * used to read a window sized for *all* streams and then filter it, so picking "stderr" with a
 * large tail silently returned a fraction of the stderr lines that existed. That was fixed
 * server-side; this pins the request the view makes, on the client side of the seam.
 */
describe('disk-mode filters', () => {
  it('asks for the stream the person picked, and omits it for "all streams"', async () => {
    const LogsView = (await import('@/views/LogsView.vue')).default
    const wrapper = mount(LogsView)
    await flushPromises()
    await nextTick()

    // The select is the one whose title is "stream".
    const select = wrapper.findAll('select').find(node => node.attributes('title') === 'stream')
    expect(select, 'no stream select').toBeDefined()

    await select!.setValue('stderr')
    await flushPromises()
    await nextTick()
    // The mocked client records the query on the pending entry.
    expect(pending.at(-1)?.query?.stream, 'picking stderr must send stream=stderr').toBe('stderr')

    await select!.setValue('')
    await flushPromises()
    await nextTick()
    // An empty value means "all streams": the key must be absent, not an empty string.
    expect(pending.at(-1)?.query?.stream, '"all streams" must omit the parameter').toBeUndefined()

    wrapper.unmount()
  })

  it('debounces the search box instead of firing per keystroke', async () => {
    vi.useFakeTimers()
    try {
      const LogsView = (await import('@/views/LogsView.vue')).default
      const wrapper = mount(LogsView)
      await vi.advanceTimersByTimeAsync(0)
      const before = pending.length

      const input = wrapper.find('input[type="search"]')
      expect(input.exists(), 'no search input').toBe(true)
      // Type five characters quickly: those are five watcher firings.
      for (const value of ['a', 'ab', 'abc', 'abcd', 'abcde'])
        await input.setValue(value)

      // Nothing new yet — the debounce has not elapsed.
      expect(pending.length, 'a search fired per keystroke').toBe(before)

      await vi.advanceTimersByTimeAsync(400)
      // Exactly one request, for the final value.
      expect(pending.length).toBe(before + 1)
      expect(pending.at(-1)?.query?.search).toBe('abcde')

      wrapper.unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })
})
