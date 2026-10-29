// @vitest-environment happy-dom
import type { HostView } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

/**
 * A host that has never been sampled has no readings, so no tile may print one.
 *
 * `emptyHostView()` (the frame `HostMonitor` starts from, and the one a panel with host vitals
 * switched off keeps for ever) answers `sampledAt: null` with `memoryUsedPercent: 0`,
 * `swapUsedPercent: 0` and `loadAvg: [0, 0, 0]`. This page rendered those literally — `0.0%`
 * memory, `0.0%` swap, `0.00` load — under a head that says "sampling off", plus a green `quiet`
 * chip, which is the picture of an idle, healthy machine. `cpuUsedPercent` and `tempCelsius` were
 * already gated to `—`; the other four were not.
 *
 * `/api/metrics` refuses the identical frame for the identical reason (`src/api/metrics.ts`), so
 * the scrape and the page disagreed about whether the panel had measured anything at all.
 */

const host = ref<HostView | null>(null)

vi.mock('@/composables/useControlPlane', () => ({
  useControlPlane: () => ({ host, now: ref(1_000_000) }),
}))

/** The frame a never-sampled host really has: every value zero, `sampledAt` null. */
function unsampled(): HostView {
  return {
    enabled: true,
    cpus: 8,
    loadAvg: [0, 0, 0],
    cpuUsedPercent: null,
    uptimeMs: 1000,
    memoryUsedPercent: 0,
    swapUsedPercent: 0,
    tempCelsius: null,
    disks: [],
    alerts: [],
    sampledAt: null,
  }
}

function sampled(): HostView {
  return { ...unsampled(), sampledAt: 1_000_000, cpuUsedPercent: 12, memoryUsedPercent: 61.4, swapUsedPercent: 7.2, loadAvg: [2.5, 2, 1.5] }
}

async function mountVitals(frame: HostView) {
  host.value = frame
  const HostVitals = (await import('../src/components/HostVitals.vue')).default
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  return mount(HostVitals, { global: { plugins: [router] } })
}

/** One metric tile, by the label it prints above its value. */
function tile(wrapper: Awaited<ReturnType<typeof mountVitals>>, label: string) {
  return wrapper.findAll('.metric').find(node => node.find('.metric__k').text() === label)
}

beforeEach(() => {
  host.value = null
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a host vitals page with no sample', () => {
  it('shows no memory, swap or load reading, because none was measured', async () => {
    const wrapper = await mountVitals(unsampled())

    for (const label of ['memory', 'swap', 'load 1m', 'load 5m', 'load 15m', 'per cpu']) {
      const node = tile(wrapper, label)
      expect(node, `the ${label} tile`).toBeDefined()
      const value = node!.find('.metric__v')
      expect(value.text(), `the ${label} tile read a number nobody measured`).toBe('—')
    }

    // The cpu tile was already honest; it stays the reference for what "no reading" looks like.
    expect(tile(wrapper, 'cpu')!.find('.metric__v').text()).toBe('—')
    wrapper.unmount()
  })

  it('does not claim the machine is quiet when nothing has been measured', async () => {
    const wrapper = await mountVitals(unsampled())
    expect(wrapper.text()).not.toContain('quiet')
    wrapper.unmount()
  })

  it('still prints the readings once the host has been sampled', async () => {
    const wrapper = await mountVitals(sampled())
    expect(tile(wrapper, 'memory')!.find('.metric__v').text()).toBe('61.4%')
    expect(tile(wrapper, 'swap')!.find('.metric__v').text()).toBe('7.2%')
    expect(tile(wrapper, 'load 1m')!.find('.metric__v').text()).toBe('2.50')
    expect(tile(wrapper, 'per cpu')!.find('.metric__v').text()).toBe('0.31')
    expect(wrapper.text()).toContain('quiet')
    wrapper.unmount()
  })
})
