// @vitest-environment happy-dom
import type { ServerConfig, ServerView } from '@shared/contracts'
import { serverSchema } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

/**
 * noc-console renders the panel's `restartRequired` badge — and only when the panel says so.
 *
 * `PUT`/`PATCH /api/servers/:id` writes config only, so a person who changed the program and read "saved"
 * would otherwise believe the change is live. The badge is the whole correction.
 *
 * Mounted rather than scanned: `ServerDetail.vue` takes its server as a prop, so the field can be set
 * both ways and the badge's *presence and absence* both asserted. A source scan can only check that the
 * string appears somewhere in the file, which is true of a badge that never renders.
 */

vi.mock('@/composables/useControlPlane', () => ({
  unwatchLogs: () => {},
  watchLogs: () => [],
  useControlPlane: () => ({
    host: computed(() => null),
    now: computed(() => 1),
    seriesOf: () => ({ cpu: [], rss: [], probe: [] }),
    act: vi.fn(async () => ({ ok: true as const, value: {} })),
  }),
}))
vi.mock('@/composables/useUi', () => ({
  flash: () => {},
  addOpen: ref(false),
  helpOpen: ref(false),
  drawerOpen: ref(false),
  useUi: () => ({ drawerOpen: ref(false), selectedId: ref(''), filter: ref('') }),
}))

function entry(restartRequired?: boolean): ServerView {
  return {
    id: 'app',
    status: 'running',
    pid: 1234,
    ...(restartRequired === undefined ? {} : { restartRequired }),
    config: serverSchema({ id: 'app', command: 'node', args: [], port: 4000, bind: 'local', enabled: true, autostart: false }) as ServerConfig,
    history: { events: [], crashes: 0, lastCrashAt: null, uptimeRatio: 1, restarts: 0 },
    lastError: null,
    nextRetryAt: null,
    unhealthySince: null,
    bindHost: '127.0.0.1',
    bufferedLines: 0,
    responseMs: 1,
    resources: null,
    adopted: false,
  } as unknown as ServerView
}

async function mountDetail(server: ServerView) {
  const ServerDetail = (await import('../src/components/ServerDetail.vue')).default
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  return mount(ServerDetail, { props: { server, workspaceId: 'default', now: 1 }, global: { plugins: [router] } })
}

describe('noc-console and a config change that needs a restart', () => {
  it('says so when the panel reports the running process is behind', async () => {
    const wrapper = await mountDetail(entry(true))
    expect(wrapper.text(), 'the badge must render when restartRequired is set').toContain('restart to apply')
  })

  it('says nothing when the process is current', async () => {
    const wrapper = await mountDetail(entry())
    expect(wrapper.text(), 'a current process must not nag').not.toContain('restart to apply')
  })
})
