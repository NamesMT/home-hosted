// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

/**
 * The Logs page's narrow-viewport server picker.
 *
 * The page lists its servers in a `<aside class="… md:flex">` rail — hidden below `md` so the log
 * pane keeps its width on a phone — and nothing else changed `selected`. Measured in Chromium at
 * 767 px: the rail was `display: none`, the page showed whichever server the list put first, and
 * the header named it as though the person had chosen it. With three servers configured the narrow
 * page could not reach the other two at all; the command palette is the only other entry point and
 * its button is hidden under `sm`, so a keyboard-less phone had no route to them either.
 *
 * What has to stay true is not merely that a control exists: it must carry the same list the rail
 * does, it must drive the same selection the rail drives (they are two views of one `selected`),
 * and switching through it must refetch that server's tail.
 */
const pending: Array<{ id: string, query?: Record<string, unknown> }> = []

// No files: a rendered download link reaches `api.logDownloadUrl(...)` from the template, and a
// `vi.mock` module namespace has no `__v_isRef`, so the render aborts before the picker exists
// (`GOTCHAS` → "A template that reaches into the API namespace from markup does not mount with a
// mocked client"). The picker is the subject here, not the file list.
const SERVERS = [
  { serverId: 'python', label: 'Python server', status: 'running', enabled: true, sizeBytes: 0, files: [] },
  { serverId: 'web', label: 'Web frontend', status: 'stopped', enabled: true, sizeBytes: 0, files: [] },
  { serverId: 'worker', label: 'Worker', status: 'crashed', enabled: true, sizeBytes: 0, files: [] },
]

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchLogHistory: (id: string, query: Record<string, unknown>) => {
      pending.push({ id, query })
      return Promise.resolve({ lines: [], searched: null })
    },
    fetchLogServers: async () => SERVERS,
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
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  RouterLink: { template: '<a><slot /></a>' },
}))

beforeEach(() => {
  pending.length = 0
})

async function mountLogs() {
  const LogsView = (await import('@/views/LogsView.vue')).default
  const wrapper = mount(LogsView, {
    global: { stubs: { Tip: { template: '<span><slot /></span>' } } },
  })
  await flushPromises()
  return wrapper
}

describe('logs server picker', () => {
  it('offers every server the rail lists, not only the first', async () => {
    const wrapper = await mountLogs()

    const picker = wrapper.findAll('select').find(node => node.attributes('aria-label') === 'Server')
    expect(picker, 'the narrow Logs page has no server picker').toBeDefined()

    const options = picker!.findAll('option').map(option => option.text())
    expect(options).toEqual(['Python server', 'Web frontend', 'Worker'])

    wrapper.unmount()
  })

  it('is the rail\'s list, hidden above `md` rather than absent', async () => {
    const wrapper = await mountLogs()

    const picker = wrapper.findAll('select').find(node => node.attributes('aria-label') === 'Server')
    // `md:hidden` is what keeps the rail the only picker once there is room for it; a control that
    // also rendered at 1280 px would be a second, redundant way to do the same thing.
    expect(picker!.classes().join(' ')).toContain('md:hidden')

    // The static heading names the server too, and below `md` it would sit beside the picker
    // printing the same name: a label the person cannot use a second time. It is hidden below `md`
    // for exactly as long as the picker is shown.
    const heading = wrapper.findAll('h1').find(node => node.text().includes('Python server'))
    expect(heading, 'the header must still name the shown server above `md`').toBeDefined()
    const headingBox = heading!.element.parentElement!
    expect(headingBox.className).toContain('hidden')
    expect(headingBox.className).toContain('md:block')

    wrapper.unmount()
  })

  it('switches the shown server and refetches its tail', async () => {
    const wrapper = await mountLogs()

    // The first load is the first server in the list.
    expect(pending.at(-1)?.id, 'the page must open on the first server').toBe('python')

    const picker = wrapper.findAll('select').find(node => node.attributes('aria-label') === 'Server')
    await picker!.setValue('web')
    await flushPromises()

    expect(pending.at(-1)?.id, 'choosing a server must fetch that server\'s tail').toBe('web')

    // The header names what is shown, so it has to follow the same selection.
    expect(wrapper.text()).toContain('Web frontend')

    wrapper.unmount()
  })
})
