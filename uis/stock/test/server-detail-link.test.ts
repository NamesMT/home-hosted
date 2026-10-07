// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

/**
 * The detail page's link must be reachable from where the viewer is.
 *
 * A `lan` entry is reported at this machine's LAN address, which nobody arriving over a public
 * hostname or a tunnel can route to. The pure rule is pinned in `test/shared/server-url.test.ts`;
 * this mounts the view, because the defect was the *wiring* — a correct rule the page did not use
 * would have looked fixed.
 *
 * The page reads its server from the workspace selection, so that is mocked to one entry and the
 * heavy children are stubbed: only the header link is under test.
 */

/** Hoisted with the mock factories, which run before this module's own top level. */
const fixture = vi.hoisted(() => ({
  server: {
    id: 'gateway',
    workspaceId: 'default',
    bindHost: '0.0.0.0',
    url: 'http://192.168.1.20:4991',
    status: 'running',
    health: 'healthy',
    portState: 'free',
    pid: 1,
    startedAt: 1,
    exitCode: null,
    exitSignal: null,
    restarts: 0,
    maxRetries: 3,
    lastError: null,
    nextRetryAt: null,
    unhealthySince: null,
    bufferedLines: 0,
    responseMs: 1,
    resources: null,
    adopted: false,
    config: {
      id: 'gateway',
      label: null,
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
      bind: 'lan',
      onPortConflict: 'block',
      logBufferLines: 500,
    },
    history: { events: [], crashes: 0, lastCrashAt: null, uptimeRatio: 1, restarts: 0 },
  },
}))

vi.mock('@/lib/api', () => ({ logDownloadUrl: () => '/api/x' }))
vi.mock('@/composables/useWorkspaces', () => ({
  useWorkspaces: () => ({
    activeId: computed(() => 'default'),
    serverById: () => fixture.server,
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
  useControlPlane: () => ({ appState: ref(null), workspaces: computed(() => []), now: ref(1) }),
  useServerLogs: () => ({ lines: () => [], version: ref(0) }),
}))

function atPage(url: string): void {
  (window as unknown as { happyDOM: { setURL: (value: string) => void } }).happyDOM.setURL(url)
}

/** The header's external link: the only `target="_blank"` anchor on the page. */
async function mountDetail() {
  const View = (await import('../src/views/ServerDetailView.vue')).default
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)', component: { template: '<div />' } }],
  })
  await router.push('/servers/gateway')
  await router.isReady()

  const wrapper = mount(View, {
    global: {
      plugins: [router],
      stubs: {
        LogViewer: true,
        ServerConfigEditor: true,
        RouterLink: { template: '<a><slot /></a>' },
        // `Tip` renders a reka-ui tooltip, which needs a provider the test does not mount.
        Tip: { template: '<span><slot /></span>' },
      },
    },
  })
  const link = wrapper.findAll('a').find(node => node.attributes('target') === '_blank')
  if (!link)
    throw new Error('the detail page rendered no external link')
  return link
}

afterEach(() => atPage('http://localhost:4999/'))

describe('the stock detail page link', () => {
  it('uses the hostname the page was reached at, keeping the server’s port', async () => {
    atPage('http://evox1.isthe.top:4999/w/default/servers/gateway')
    const link = await mountDetail()

    expect(link.attributes('href')).toBe('http://evox1.isthe.top:4991')
    // The visible text is the link, so it must not keep the unreachable address either.
    expect(link.text()).toBe('http://evox1.isthe.top:4991')
  })

  it('keeps the LAN address when the viewer is on the machine', async () => {
    atPage('http://localhost:4999/')
    expect((await mountDetail()).attributes('href')).toBe('http://192.168.1.20:4991')
  })
})
