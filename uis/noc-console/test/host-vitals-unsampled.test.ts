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

/**
 * A reading the **platform** cannot take says so; it is not the same silence as "not sampled".
 *
 * Both render `—`, and they resolve differently: an unsampled frame resolves on the next sample,
 * while Windows' missing load average never will. Until this, a person on Windows saw `—` beside a
 * live memory reading and had no way to tell the two cases apart. `hostReadings` carries the names
 * now, so the page can say which.
 *
 * The stock UI's half is `uis/stock/test/host-vitals-unmeasured.test.ts` — same rule, translated.
 */
describe('a reading the platform cannot take', () => {
  it('names the platform limit instead of leaving a bare dash', async () => {
    // Windows: no load average. The rest of the sample is real.
    const wrapper = await mountVitals({ ...sampled(), unmeasured: ['load'], loadAvg: [0, 0, 0] })

    const loadTile = tile(wrapper, 'load 1m')!
    expect(loadTile.find('.metric__v').text(), 'no number is printed').toBe('—')
    expect(loadTile.text(), 'and the reason is').toContain('unavailable on this platform')

    // A reading that WAS taken says nothing extra.
    expect(tile(wrapper, 'memory')!.text()).not.toContain('unavailable on this platform')
    wrapper.unmount()
  })

  it('says nothing when the platform took every reading', async () => {
    const wrapper = await mountVitals(sampled())
    expect(wrapper.text()).not.toContain('unavailable on this platform')
    wrapper.unmount()
  })

  /**
   * A held-back sample is not a current reading, and the page has to say which it is showing.
   *
   * Sampling switched off keeps the last frame with its stamp, so the head reads "sampled 4m ago"
   * beside figures that stopped updating. Without this, "sampled 4m ago" looks like a slow sampler.
   */
  it('marks a sample the panel is holding back as not current', async () => {
    const wrapper = await mountVitals({ ...sampled(), enabled: false })
    expect(wrapper.text()).toContain('not a current reading')
    wrapper.unmount()
  })
})
