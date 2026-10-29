// @vitest-environment happy-dom
import type { ServerConfig, ServerView } from '@shared/contracts'
import { serverSchema } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

/**
 * The number and the sparkline in one tile answer the same question, so they must not disagree.
 *
 * `cpuPercent` is summed over a process tree, so it counts cores. `ServerDetail`'s chart was fixed to
 * scale with `cpus × 100`; the number beside it was not, and kept the per-core `toneClass(cpu, 40,
 * 80)`. Measured on a 24-core host: a server at `1000%` — a sixth of the box — painted its number
 * `--danger` while the sparkline directly beneath it stayed `--accent`, and the list row one click
 * away agreed with the sparkline. Two renderings of one reading, two verdicts.
 *
 * A helper test cannot see a component restating the rule, so this drives the real component and
 * reads the two class bindings off the rendered tile.
 */

/** The detail pane opens a log stream on mount; this only needs the metric tile. */
class FakeEventSource {
  addEventListener(): void {}
  close(): void {}
}

const hostCpus = ref<number | null>(24)
/** A sample series, so the sparkline has a run to draw and its stroke can be read. */
const cpuSeries = ref<(number | null)[]>([null, null])

vi.mock('@/composables/useControlPlane', () => ({
  unwatchLogs: () => {},
  watchLogs: () => [],
  useControlPlane: () => ({
    host: computed(() => (hostCpus.value === null ? null : { cpus: hostCpus.value })),
    seriesOf: () => ({ cpu: cpuSeries.value, rss: [], probe: [] }),
    act: async () => {},
    clearLogs: async () => {},
    remove: async () => {},
    setAutostart: async () => {},
    setBind: async () => {},
    setEnabled: async () => {},
    lastError: ref(null),
  }),
}))
vi.mock('@/composables/useUi', () => ({
  flash: () => {},
  drawerOpen: ref(false),
  useUi: () => ({ drawerOpen: ref(false) }),
}))

beforeEach(() => {
  hostCpus.value = 24
  cpuSeries.value = [null, null]
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function entry(cpuPercent: number | null): ServerView {
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
    resources: cpuPercent === null ? null : { cpuPercent, rssBytes: 1, processes: 1, sampledAt: 1 },
    adopted: false,
    config: serverSchema({ id: 'worker', command: 'node', args: [], port: 4991, bind: 'local' }) as ServerConfig,
    history: { events: [], crashes: 0, lastCrashAt: null, uptimeRatio: 1, restarts: 0 },
  } as unknown as ServerView
}

/** The cpu tile: the one whose label is `cpu`, not the probe tile above it. */
async function mountCpuTile(cpuPercent: number | null, series: number | null = cpuPercent) {
  cpuSeries.value = [series, series]
  const ServerDetail = (await import('../src/components/ServerDetail.vue')).default
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()

  const wrapper = mount(ServerDetail, {
    props: { server: entry(cpuPercent), workspaceId: 'default', now: 1 },
    global: { plugins: [router] },
  })

  const tile = wrapper.findAll('.metric').find(node => node.find('.metric__k').text() === 'cpu')
  if (!tile)
    throw new Error('the detail pane rendered no cpu tile')
  const value = tile.find('.metric__v')
  const line = tile.find('polyline')
  return { wrapper, value, line }
}

describe('the cpu tile agrees with itself', () => {
  it('paints a sixth of a 24-core box the same colour in the number and the sparkline', async () => {
    const { wrapper, value, line } = await mountCpuTile(1000)

    // 1000% of 2400% is the warn band — a sixth of the box, not an emergency.
    expect(value.classes(), 'the number').toContain('metric__v--warn')
    expect(value.classes(), 'the number').not.toContain('metric__v--danger')
    // The sparkline beside it reads the same scale, which is what makes this one verdict.
    expect(line?.attributes('stroke')).toBe('var(--warn)')
    wrapper.unmount()
  })

  it('still calls a pegged machine dangerous, in both', async () => {
    const { wrapper, value, line } = await mountCpuTile(2400)
    expect(value.classes()).toContain('metric__v--danger')
    expect(line?.attributes('stroke')).toBe('var(--danger)')
    wrapper.unmount()
  })

  it('leaves an absent reading dim rather than in a healthy colour', async () => {
    const { wrapper, value } = await mountCpuTile(null)
    expect(value.classes()).toContain('metric__v--dim')
    expect(value.text()).toBe('—')
    wrapper.unmount()
  })
})
