// @vitest-environment happy-dom
import type { ServerConfig, ServerView } from '@shared/contracts'
import { serverSchema } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

/**
 * One probe latency, one verdict — in the tile's number, its sparkline, and the list row.
 *
 * `responseMs` was painted three times with two answers. The number used `toneClass(responseMs, 300,
 * 1000)`; the sparkline under it called its own `probeColor()` holding a *second* copy of the same
 * `300`/`1000`; and the list row tested `>= 1000` alone, painting `warn` where the pane painted
 * nothing. So `1500 ms` read `danger` in the pane and only `warn` in the row, and `500 ms` read
 * `warn` in one and plain in the other. `probeColor()` also read `responseMs ?? 0`, so a probe that
 * had never run — a stopped entry — was painted `--ok`: a healthy verdict for no reading at all.
 *
 * The cpu tile needed the same repair, and its guard proved the shape: a helper test cannot see a
 * component restating the rule, so this drives the real components and reads the painted class and
 * stroke off them.
 */

class FakeEventSource {
  addEventListener(): void {}
  close(): void {}
}

const hostCpus = ref<number | null>(24)
const probeSeries = ref<(number | null)[]>([null, null])

vi.mock('@/composables/useControlPlane', () => ({
  unwatchLogs: () => {},
  watchLogs: () => [],
  useControlPlane: () => ({
    host: computed(() => (hostCpus.value === null ? null : { cpus: hostCpus.value })),
    seriesOf: () => ({ cpu: [], rss: [], probe: probeSeries.value }),
    act: async () => {},
    clearLogs: async () => {},
    remove: async () => {},
    setAutostart: async () => {},
    setBind: async () => {},
    setEnabled: async () => {},
    lastError: ref(null),
    now: ref(1),
  }),
}))
vi.mock('@/composables/useUi', () => ({
  flash: () => {},
  drawerOpen: ref(false),
  useUi: () => ({ drawerOpen: ref(false), selectedId: ref(null), filter: ref('') }),
}))

beforeEach(() => {
  probeSeries.value = [null, null]
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function entry(responseMs: number | null, status: ServerView['status'] = 'running'): ServerView {
  return {
    id: 'worker',
    workspaceId: 'default',
    bindHost: '127.0.0.1',
    url: null,
    status,
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
    responseMs,
    resources: { cpuPercent: 1, rssBytes: 1, processes: 1, sampledAt: 1 },
    adopted: false,
    config: serverSchema({ id: 'worker', command: 'node', args: [], port: 4991, bind: 'local' }) as ServerConfig,
    history: { events: [], crashes: 0, lastCrashAt: null, uptimeRatio: 1, restarts: 0 },
  } as unknown as ServerView
}

/** The detail pane's probe tile: the one whose label is `probe`. */
async function mountProbeTile(responseMs: number | null, status: ServerView['status'] = 'running') {
  probeSeries.value = [responseMs, responseMs]
  const ServerDetail = (await import('../src/components/ServerDetail.vue')).default
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()

  const wrapper = mount(ServerDetail, {
    props: { server: entry(responseMs, status), workspaceId: 'default', now: 1 },
    global: { plugins: [router] },
  })

  const tile = wrapper.findAll('.metric').find(node => node.find('.metric__k').text() === 'probe')
  if (!tile)
    throw new Error('the detail pane rendered no probe tile')
  return { wrapper, value: tile.find('.metric__v'), line: tile.find('polyline') }
}

/** The list row's probe cell: the eleventh cell, after the `probe` header. */
async function mountProbeCell(responseMs: number | null) {
  const ServerList = (await import('../src/components/ServerList.vue')).default
  const wrapper = mount(ServerList, {
    props: { servers: [entry(responseMs)], total: 1, workspaceId: 'default', configPath: null },
    global: { plugins: [createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:p(.*)', component: { template: '<div />' } }],
    })] },
  })
  const headers = wrapper.findAll('thead th').map(node => node.text())
  const index = headers.indexOf('probe')
  if (index < 0)
    throw new Error(`the list rendered no probe column: ${headers.join(', ')}`)
  return { wrapper, cell: wrapper.findAll('tbody tr')[0]!.findAll('td')[index]! }
}

describe('the probe latency has one verdict', () => {
  it('paints a slow probe the same colour in the number, the sparkline and the row', async () => {
    // 1500 ms is past the danger threshold, so all three must call it dangerous.
    const { wrapper, value, line } = await mountProbeTile(1500)
    expect(value.classes(), 'the tile number').toContain('metric__v--danger')
    expect(line?.attributes('stroke'), 'the tile sparkline').toBe('var(--danger)')
    wrapper.unmount()

    const list = await mountProbeCell(1500)
    expect(list.cell.classes(), 'the list row').toContain('danger')
    list.wrapper.unmount()
  })

  it('calls a warn-band probe warn in the row, not plain', async () => {
    // The row tested `>= 1000` only, so this reading was uncoloured one click from a warn tile.
    const { wrapper, value, line } = await mountProbeTile(500)
    expect(value.classes()).toContain('metric__v--warn')
    expect(line?.attributes('stroke')).toBe('var(--warn)')
    wrapper.unmount()

    const list = await mountProbeCell(500)
    expect(list.cell.classes(), 'the list row').toContain('warn')
    expect(list.cell.classes(), 'the list row').not.toContain('danger')
    list.wrapper.unmount()
  })

  it('leaves a fast probe uncoloured in all three, rather than green', async () => {
    const { wrapper, value, line } = await mountProbeTile(12)
    expect(value.classes(), 'the number adds no verdict class').not.toContain('metric__v--warn')
    expect(value.classes()).not.toContain('metric__v--danger')
    expect(line?.attributes('stroke')).toBe('var(--accent)')
    wrapper.unmount()

    const list = await mountProbeCell(12)
    expect(list.cell.classes()).not.toContain('warn')
    expect(list.cell.classes()).not.toContain('danger')
    list.wrapper.unmount()
  })

  /**
   * The one the third copy hid completely: `probeColor()` read `responseMs ?? 0`, so an entry that
   * had never been probed got `--ok` beside a `—`. A missing reading is not a healthy one.
   */
  it('paints a probe that never ran as absent, never as healthy', async () => {
    const { wrapper, value, line } = await mountProbeTile(null)
    expect(value.classes(), 'the number').toContain('metric__v--dim')
    expect(value.text()).toBe('—')
    // No sample draws the dashed baseline, so no stroke carries the verdict at all.
    expect(line.exists(), 'an absent series draws no segment').toBe(false)
    wrapper.unmount()

    const list = await mountProbeCell(null)
    expect(list.cell.classes(), 'the row').toContain('faint')
    expect(list.cell.classes()).not.toContain('warn')
    list.wrapper.unmount()
  })

  it('has no band left for a stopped entry, whose probe is gone with its process', async () => {
    const { wrapper, value } = await mountProbeTile(4, 'stopped')
    expect(value.classes(), 'a stopped entry has no live reading').toContain('metric__v--dim')
    wrapper.unmount()
  })
})
