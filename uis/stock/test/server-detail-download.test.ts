// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

/**
 * The detail page must not offer a download the panel will refuse.
 *
 * The link was gated on `config.logBufferLines > 0`, which describes the *in-memory* buffer and says
 * nothing about disk, and it always named `<id>.log` by convention. `GET /api/logs/:id/download`
 * answers `404 UNKNOWN_LOG_FILE` for a name that is not in the entry's file list, so a server that
 * had never written a line still showed "Download the persisted file". Measured against the running
 * dev panel at 1280 px: a visible 32×32 link on `/w/default/servers/python` pointed at
 * `/api/logs/python/download?file=python.log&workspace=default`, the API reported `files: []` for
 * that entry, and fetching the link answered **404**.
 *
 * Mounted rather than helper-tested, because the defect was the *gate*: the helper can be right
 * while the page consults the wrong signal.
 */
const fixture = vi.hoisted(() => ({
  /** The file list the panel would answer with; the defect needed `enabled` true and this empty. */
  files: [] as Array<{ name: string, sizeBytes: number }>,
  /** The in-memory buffer size the old gate read. Non-zero on purpose: it is not the signal. */
  logBufferLines: 500,
  fetchCalls: [] as string[],
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchLogServers: async (workspace: string) => {
      fixture.fetchCalls.push(workspace)
      return [{
        serverId: 'gateway',
        label: 'Gateway',
        status: 'stopped',
        // Persistence is on, which is exactly what made the old gate look satisfied.
        enabled: true,
        sizeBytes: fixture.files.reduce((sum, file) => sum + file.sizeBytes, 0),
        files: fixture.files,
      }]
    },
  }
})
vi.mock('@/composables/useWorkspaces', () => ({
  useWorkspaces: () => ({
    activeId: computed(() => 'default'),
    serverById: () => ({
      id: 'gateway',
      workspaceId: 'default',
      bindHost: '127.0.0.1',
      url: 'http://127.0.0.1:4991',
      status: 'stopped',
      health: 'unknown',
      portState: 'free',
      pid: null,
      startedAt: null,
      exitCode: null,
      exitSignal: null,
      restarts: 0,
      maxRetries: 3,
      lastError: null,
      nextRetryAt: null,
      unhealthySince: null,
      bufferedLines: 0,
      responseMs: null,
      resources: null,
      adopted: false,
      config: {
        id: 'gateway',
        label: 'Gateway',
        enabled: true,
        autostart: false,
        persistent: false,
        command: 'node',
        args: [],
        cwd: '.',
        env: {},
        dataEnvs: {},
        envFile: null,
        port: 4991,
        bind: 'local',
        onPortConflict: 'block',
        logBufferLines: fixture.logBufferLines,
      },
      history: { events: [], crashes: 0, lastCrashAt: null, uptimeRatio: 1, restarts: 0 },
    }),
    seriesOf: () => ({ cpu: [], rss: [], probe: [], ts: [] }),
    select: () => {},
    removeServer: async () => {},
    setEnabled: async () => {},
    setAutostart: async () => {},
    setBind: async () => {},
    clearLogs: async () => {},
    freePort: async () => {},
  }),
}))
vi.mock('@/composables/useControlPlane', () => ({
  useControlPlane: () => ({
    appState: ref(null),
    workspaces: computed(() => []),
    host: computed(() => null),
    now: ref(1),
  }),
  useServerLogs: () => ({ lines: () => [], version: ref(0) }),
}))

async function mountDetail() {
  const View = (await import('../src/views/ServerDetailView.vue')).default
  const router = createRouter({
    history: createMemoryHistory(),
    // The page reads the id from `route.params.id`, so the route must carry one — a catch-all
    // leaves `id` empty and the page then has no entry to list files for.
    routes: [{ path: '/w/:workspaceId/servers/:id', component: { template: '<div />' } }],
  })
  await router.push('/w/default/servers/gateway')
  await router.isReady()
  const wrapper = mount(View, {
    global: {
      plugins: [router],
      stubs: {
        // The real viewer is what turns the prop into the link, so it is *not* stubbed: a stubbed
        // child would prove the prop was passed and nothing about the control a person sees.
        ServerConfigEditor: true,
        RouterLink: { template: '<a><slot /></a>' },
        Tip: { template: '<span><slot /></span>' },
      },
    },
  })
  await flushPromises()
  return wrapper
}

afterEach(() => {
  fixture.files = []
  fixture.logBufferLines = 500
  fixture.fetchCalls.length = 0
})

describe('the detail page log download', () => {
  it('does not render the LogViewer’s download when the panel holds no file', async () => {
    fixture.files = []
    const wrapper = await mountDetail()

    expect(
      wrapper.findAll('a').find(node => (node.attributes('href') ?? '').includes('/download')),
      'no file on disk means no download link',
    ).toBeUndefined()
    expect(fixture.fetchCalls.length, 'the page must ask the panel what exists').toBeGreaterThan(0)

    wrapper.unmount()
  })

  it('names the listed file when one exists', async () => {
    fixture.files = [{ name: 'gateway.log', sizeBytes: 7 }]
    const wrapper = await mountDetail()

    const link = wrapper.findAll('a').find(node => (node.attributes('href') ?? '').includes('/download'))
    expect(link, 'a listed file must be downloadable').toBeDefined()
    expect(link!.attributes('href')).toContain('file=gateway.log')
    expect(link!.attributes('download')).toBe('gateway.log')

    wrapper.unmount()
  })

  it('keeps the gate about disk, not the in-memory buffer', async () => {
    // A buffer of 0 with a file on disk is still downloadable; a big buffer with no file is not.
    fixture.logBufferLines = 0
    fixture.files = [{ name: 'gateway.log', sizeBytes: 7 }]
    const wrapper = await mountDetail()
    const link = wrapper.findAll('a').find(node => (node.attributes('href') ?? '').includes('/download'))
    expect(link, 'the gate is about disk, not the in-memory buffer').toBeDefined()
    wrapper.unmount()
  })
})
