// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'

/**
 * The Logs page must not offer a download the panel will refuse.
 *
 * `GET /api/logs/:id/download` answers `404 UNKNOWN_LOG_FILE` for a name that is not in the entry's
 * file list. The header's link was gated on `enabled` — the workspace's `logs.persist` setting — and
 * named `<id>.log` by convention, so a workspace with persistence on and no file written yet
 * rendered "download python.log" for a URL that always fails. Measured against the running dev panel
 * at 1280 px: the link was a visible 126×24 control, `/api/logs` reported `files: []` for the same
 * server, and fetching the link answered **404**.
 *
 * Mounted rather than unit-tested, because the defect was the *gate* — a correct helper that the
 * page consults for the wrong reason would look fixed.
 */
const servers = ref<Array<Record<string, unknown>>>([])

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchLogServers: async () => servers.value,
    fetchLogHistory: async () => ({ lines: [], searched: null }),
    clearLogs: async () => ({}),
  }
})
vi.mock('@/composables/useControlPlane', () => ({
  resetLogs: () => {},
  unwatchLogs: () => {},
  watchLogs: () => [],
}))
vi.mock('@/composables/useUi', () => ({ selectedId: ref('python'), flash: () => {}, useUi: () => ({ selectedId: ref('python') }) }))
vi.mock('@/composables/useKeymap', () => ({ useKeyHandler: () => {} }))
vi.mock('@/composables/useWorkspaces', () => ({
  useWorkspaces: () => ({
    activeId: computed(() => 'default'),
    workspaces: ref([{ id: 'default', label: 'Default', servers: [] }]),
    selected: computed(() => ({ id: 'default', label: 'Default', servers: [] })),
    serversOf: () => [],
  }),
}))

function entry(files: Array<{ name: string, sizeBytes: number }>) {
  return {
    serverId: 'python',
    label: 'Python server',
    status: 'stopped',
    enabled: true,
    sizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    files,
  }
}

beforeEach(() => {
  servers.value = []
})

describe('the log download link', () => {
  it('is absent when persistence is on but no file exists', async () => {
    // The exact state the defect needed: `enabled` true, `files` empty.
    servers.value = [entry([])]
    const LogsView = (await import('@/views/LogsView.vue')).default
    const wrapper = mount(LogsView)
    await flushPromises()

    const link = wrapper.findAll('a').find(node => (node.attributes('href') ?? '').includes('/download'))
    expect(link, 'a download link must not be offered for a file the panel does not hold').toBeUndefined()
    expect(wrapper.text()).not.toContain('download python.log')

    wrapper.unmount()
  })

  it('names the listed file once one exists', async () => {
    servers.value = [entry([{ name: 'python.log', sizeBytes: 12 }])]
    const LogsView = (await import('@/views/LogsView.vue')).default
    const wrapper = mount(LogsView)
    await flushPromises()

    const link = wrapper.findAll('a').find(node => (node.attributes('href') ?? '').includes('/download'))
    expect(link, 'a listed file is downloadable').toBeDefined()
    expect(link!.attributes('href')).toContain('file=python.log')
    expect(link!.text()).toContain('download python.log')

    wrapper.unmount()
  })
})
