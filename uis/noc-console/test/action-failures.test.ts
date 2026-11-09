// @vitest-environment happy-dom
import type { ServerConfig, ServerView } from '@shared/contracts'
import { serverSchema } from '@shared/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { runKeyHandlers } from '../src/composables/useKeymap'

/**
 * The noc-console swallowed action failures: the enabled/autostart toggles and the bind select said
 * nothing and stayed flipped, "buffered logs cleared" was reported whatever happened, and start-all /
 * stop-all ignored their result. Every action now resolves to its own outcome, and the shortcuts
 * neither repeat on a held key nor stack on a server whose action is still running.
 */

const failure = { ok: false as const, error: 'the panel refused' }
const flash = vi.fn()
const act = vi.fn(async () => ({ ok: true as const, value: { ok: true } }))
const busy = ref(false)
const outcome = ref<{ ok: true, value: unknown } | typeof failure>(failure)

vi.mock('@/composables/useControlPlane', () => ({
  unwatchLogs: () => {},
  watchLogs: () => [],
  useControlPlane: () => ({
    host: computed(() => null),
    now: computed(() => 1),
    seriesOf: () => ({ cpu: [], rss: [], probe: [] }),
    act: async () => outcome.value,
    clearLogs: async () => outcome.value,
    remove: async () => outcome.value,
    setAutostart: async () => outcome.value,
    setBind: async () => outcome.value,
    setEnabled: async () => outcome.value,
  }),
}))
vi.mock('@/composables/useWorkspaces', () => ({
  useWorkspaces: () => ({
    activeId: computed(() => 'default'),
    servers: computed(() => [entry()]),
    serverById: () => entry(),
    configError: computed(() => null),
    configPath: computed(() => ''),
    selected: computed(() => ({ label: 'Default' })),
    runningCount: computed(() => 1),
    serverCount: computed(() => 1),
    configWarnings: computed(() => []),
    act,
    isBusy: () => busy.value,
    clearLogs: async () => outcome.value,
    startAll: async () => outcome.value,
    stopAll: async () => outcome.value,
  }),
}))
vi.mock('@/composables/useUi', () => ({
  flash: (...args: unknown[]) => flash(...args),
  addOpen: ref(false),
  helpOpen: ref(false),
  drawerOpen: ref(false),
  useUi: () => ({ drawerOpen: ref(false), selectedId: ref('worker'), filter: ref('') }),
}))

class FakeEventSource {
  addEventListener(): void {}
  close(): void {}
}

beforeEach(() => {
  flash.mockClear()
  act.mockClear()
  busy.value = false
  outcome.value = failure
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function entry(): ServerView {
  return {
    id: 'worker',
    workspaceId: 'default',
    bindHost: '127.0.0.1',
    url: null,
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
    config: serverSchema({ id: 'worker', command: 'node', args: [], port: 4991, bind: 'local', enabled: true, autostart: false }) as ServerConfig,
    history: { events: [], crashes: 0, lastCrashAt: null, uptimeRatio: 1, restarts: 0 },
  } as unknown as ServerView
}

async function router() {
  const created = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)', component: { template: '<div />' } }] })
  await created.push('/')
  await created.isReady()
  return created
}

async function mountDetail() {
  const ServerDetail = (await import('../src/components/ServerDetail.vue')).default
  return mount(ServerDetail, { props: { server: entry(), workspaceId: 'default', now: 1 }, global: { plugins: [await router()] } })
}

describe('serverDetail reports a refused change', () => {
  it('puts a refused toggle back and says why', async () => {
    const wrapper = await mountDetail()
    const enabled = wrapper.findAll('input[type="checkbox"]').find(box => box.element.parentElement?.textContent?.includes('enabled'))!
    const element = enabled.element as HTMLInputElement
    expect(element.checked).toBe(true)
    element.checked = false
    await enabled.trigger('change')
    await flushPromises()
    expect(element.checked, 'the box must show what the entry is, not what was asked').toBe(true)
    expect(flash).toHaveBeenCalledWith('the panel refused', 'error')
    wrapper.unmount()
  })

  it('puts a refused bind back', async () => {
    const wrapper = await mountDetail()
    const select = wrapper.find('select').element as HTMLSelectElement
    select.value = 'lan'
    await wrapper.find('select').trigger('change')
    await flushPromises()
    expect(select.value).toBe('local')
    expect(flash).toHaveBeenCalledWith('the panel refused', 'error')
    wrapper.unmount()
  })

  it('does not claim a buffer was cleared when it was not', async () => {
    const wrapper = await mountDetail()
    await wrapper.find('button[title^="clear the in-memory buffer"]').trigger('click')
    await flushPromises()
    expect(flash).toHaveBeenCalledWith('the panel refused', 'error')
    expect(flash).not.toHaveBeenCalledWith(expect.stringContaining('cleared'))

    outcome.value = { ok: true, value: undefined }
    await wrapper.find('button[title^="clear the in-memory buffer"]').trigger('click')
    await flushPromises()
    expect(flash).toHaveBeenLastCalledWith('worker: buffered logs cleared', 'info')
    wrapper.unmount()
  })
})

describe('serversView', () => {
  async function mountView() {
    const ServersView = (await import('../src/views/ServersView.vue')).default
    return mount(ServersView, {
      global: {
        plugins: [await router()],
        stubs: { ServerDetail: true, ServerList: true, Splitpanes: { template: '<div><slot /></div>' }, Pane: { template: '<div><slot /></div>' } },
      },
    })
  }

  it('reports a failed start-all', async () => {
    const wrapper = await mountView()
    const button = wrapper.findAll('button').find(node => node.text() === 'start all')!
    await button.trigger('click')
    await flushPromises()
    expect(flash).toHaveBeenCalledWith('the panel refused', 'error')
    wrapper.unmount()
  })

  it('ignores a held key and a press while the server is busy', async () => {
    const wrapper = await mountView()
    runKeyHandlers('s', new KeyboardEvent('keydown', { key: 's', repeat: true }))
    expect(act).not.toHaveBeenCalled()

    busy.value = true
    runKeyHandlers('x', new KeyboardEvent('keydown', { key: 'x' }))
    expect(act).not.toHaveBeenCalled()

    busy.value = false
    runKeyHandlers('r', new KeyboardEvent('keydown', { key: 'r' }))
    expect(act).toHaveBeenCalledWith('worker', 'restart')
    wrapper.unmount()
  })
})
