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

vi.mock('@/lib/api', async (importOriginal) => {
  // Spread the real module: the view does `import * as api`, and a plain object returned from
  // here has no module namespace, so Vue's ref-unwrapping on `api.<fn>` throws
  // ("No __v_isRef export is defined on the mock"). Keeping the real shape and overriding only
  // the two calls this test drives avoids testing a fixture instead of the view.
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchLogHistory: (_workspace: string, _id: string, query: Record<string, unknown>) => {
      pending.push({ query })
      return Promise.resolve({ lines: [{ ts: 1, stream: 'stderr', text: 'boom' }], searched: null })
    },
    fetchLogServers: async () => [{
      serverId: 'web',
      label: 'web',
      status: 'running',
      enabled: true,
      sizeBytes: 10,
      files: [],
    }],
    clearLogs: async () => ({}),
  }
})
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
    const wrapper = mount(LogsView, {
      global: {
        // `LogViewer` renders `Tip`, which needs reka-ui's `TooltipProvider` — supplied by the
        // app shell, absent in a bare mount. Stubbing the tip keeps the test on the filter
        // instead of on the tooltip plumbing, and the alternative (wrapping every mount in a
        // provider) would make this file about the view's whole tree.
        stubs: { Tip: { template: '<span><slot /></span>' } },
      },
    })
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

/**
 * The search box, which `noc-console` had and `stock` did not — the same shape of gap as the
 * stream select above, and the same fix.
 *
 * Two things matter. The query is only sent when it is non-empty (an empty `search` would be a
 * filter for nothing), and it is debounced: each request reads and parses up to 5000 lines
 * server-side, so one per keystroke is waste.
 */
describe('logs search box', () => {
  async function mountLogs() {
    const LogsView = (await import('@/views/LogsView.vue')).default
    const wrapper = mount(LogsView, {
      global: { stubs: { Tip: { template: '<span><slot /></span>' } } },
    })
    await flushPromises()
    return wrapper
  }

  it('is absent from the request until something is typed', async () => {
    const wrapper = await mountLogs()
    expect(pending.at(-1)?.query?.search, 'the initial load must not search').toBeUndefined()
    wrapper.unmount()
  })

  it('debounces typing into one request for the final value', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = await mountLogs()
      const before = pending.length

      const input = wrapper.find('input[type="search"]')
      expect(input.exists(), 'the Logs page has no search box').toBe(true)

      // Five keystrokes in quick succession.
      for (const value of ['o', 'ou', 'out', 'outp', 'outpu'])
        await input.setValue(value)

      // Nothing fired yet.
      expect(pending.length, 'a request fired per keystroke').toBe(before)

      await vi.advanceTimersByTimeAsync(400)
      expect(pending.length).toBe(before + 1)
      expect(pending.at(-1)?.query?.search).toBe('outpu')

      // Clearing it must drop the parameter again, not send an empty filter.
      await input.setValue('')
      await vi.advanceTimersByTimeAsync(400)
      expect(pending.at(-1)?.query?.search).toBeUndefined()

      wrapper.unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('shows how many lines the search looked at', async () => {
    // The server reports the window it actually read; a short log reads fewer than it asked for,
    // and this number is printed for a person.
    const wrapper = await mountLogs()
    expect(wrapper.text()).not.toContain('searched')

    const api = await import('@/lib/api')
    vi.spyOn(api, 'fetchLogHistory').mockResolvedValue({
      lines: [{ ts: 1, stream: 'stdout', text: 'match' }],
      searched: 42,
    } as never)
    const input = wrapper.find('input[type="search"]')
    await input.setValue('match')
    await new Promise(resolve => setTimeout(resolve, 350))
    await flushPromises()

    expect(wrapper.text()).toContain('searched 42 lines')
    wrapper.unmount()
  })
})
