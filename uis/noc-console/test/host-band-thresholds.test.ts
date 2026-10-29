// @vitest-environment happy-dom
import type { HostView } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

/**
 * Every host band is a verdict on the threshold the panel itself notifies on.
 *
 * The per-cpu load got this treatment first. The other three kept literals: `HostRail` banded swap
 * at `50`/`80` while `hostSchema` defaults the swap alert to **50**, so a box the panel was actively
 * notifying about sat at `warn` — the rail contradicting its own notification. And `tempCelsius`
 * defaulted to 85 in the schema but was hardcoded to `85` in the rail and to a `70`/`85` pair in
 * `HostVitals`, so raising `host.tempCelsius` to 95 left a 90 °C box painted `danger` for a
 * notification that could never arrive.
 *
 * A surface cannot follow a number it is never given, so the thresholds travel on the frame and one
 * predicate (`percentageBand`, `src/shared/host-readings.ts`) decides each band. This drives the
 * real components against exactly what `/api/state` sends.
 */

const host = ref<HostView | null>(null)

vi.mock('@/composables/useControlPlane', () => ({
  useControlPlane: () => ({
    host,
    now: ref(1_000_000),
    control: ref({ url: 'http://127.0.0.1:3999', auth: { exposed: false } }),
  }),
}))

/** A sampled frame whose readings sit at the given percentages, with the panel's thresholds. */
type Thresholds = Pick<HostView, 'memoryUsedPercentAlert' | 'swapUsedPercentAlert' | 'tempCelsiusAlert'>

function frame(values: { memory?: number, swap?: number, temp?: number }, thresholds: Thresholds = {}): HostView {
  return {
    enabled: true,
    cpus: 8,
    loadAvg: [0.1, 0.1, 0.1],
    cpuUsedPercent: 5,
    uptimeMs: 1000,
    memoryUsedPercent: values.memory ?? 10,
    swapUsedPercent: values.swap ?? 1,
    tempCelsius: values.temp ?? 40,
    disks: [],
    alerts: [],
    sampledAt: 1_000_000,
    ...(thresholds.memoryUsedPercentAlert === undefined ? {} : { memoryUsedPercentAlert: thresholds.memoryUsedPercentAlert }),
    ...(thresholds.swapUsedPercentAlert === undefined ? {} : { swapUsedPercentAlert: thresholds.swapUsedPercentAlert }),
    ...(thresholds.tempCelsiusAlert === undefined ? {} : { tempCelsiusAlert: thresholds.tempCelsiusAlert }),
  }
}

async function mountRail(view: HostView) {
  host.value = view
  const HostRail = (await import('../src/components/HostRail.vue')).default
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)', component: { template: '<div />' } }] })
  await router.push('/')
  await router.isReady()
  return mount(HostRail, { global: { plugins: [router] } })
}

/** The rail's cell that prints `label` above its bar. */
function railBar(wrapper: Awaited<ReturnType<typeof mountRail>>, label: string) {
  const cell = wrapper.findAll('.rail__cell').find(node => node.text().includes(label))
  expect(cell, `the rail rendered no ${label} cell`).toBeDefined()
  return cell!.find('.rail__bar')
}

beforeEach(() => {
  host.value = null
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a percentage band follows the alert threshold', () => {
  /**
   * The shipped defaults alone are enough to show the defect: the swap alert fires at 50 in
   * `hostSchema`, and the rail painted that number `warn` because it had hardcoded 80 as danger.
   */
  it('paints danger at the swap threshold the panel notifies on, out of the box', async () => {
    const wrapper = await mountRail(frame({ swap: 52 }, { swapUsedPercentAlert: 50 }))
    expect(railBar(wrapper, 'swap').classes(), 'the panel notifies at 50, so 52 is a breach').toContain('rail__bar--danger')
    wrapper.unmount()
  })

  it('does not call a reading a breach when the panel would not notify', async () => {
    // 90 °C against a threshold a person raised to 95: close enough to be `warn`, but no alert
    // fires, so `danger` here is a verdict the panel does not agree with.
    const wrapper = await mountRail(frame({ temp: 90 }, { tempCelsiusAlert: 95 }))
    const bar = railBar(wrapper, 'temp')
    expect(bar.classes(), 'a box a person raised the threshold on').not.toContain('rail__bar--danger')
    wrapper.unmount()
  })

  it('warns well below the threshold, the approach band the load bar already had', async () => {
    // 70% of the threshold: far enough away to be no alert, close enough to be worth a colour.
    const wrapper = await mountRail(frame({ temp: 40 }, { tempCelsiusAlert: 95 }))
    expect(railBar(wrapper, 'temp').classes()).not.toContain('rail__bar--warn')
    wrapper.unmount()
  })

  it('still paints a reading past the threshold the panel notifies on', async () => {
    const wrapper = await mountRail(frame({ temp: 96 }, { tempCelsiusAlert: 95 }))
    expect(railBar(wrapper, 'temp').classes()).toContain('rail__bar--danger')
    wrapper.unmount()
  })

  it('keeps the default band for a panel that sends no threshold', async () => {
    // An older panel alerted on the schema defaults, and those are what the band assumes.
    const wrapper = await mountRail(frame({ swap: 52 }))
    expect(railBar(wrapper, 'swap').classes()).toContain('rail__bar--danger')
    wrapper.unmount()
  })

  it('paints nothing alarming when the alert is switched off', async () => {
    // `0` disables the alert in `sampleHost`, so there is no threshold to cross.
    const wrapper = await mountRail(frame({ memory: 99 }, { memoryUsedPercentAlert: 0 }))
    const bar = railBar(wrapper, 'mem')
    expect(bar.classes()).not.toContain('rail__bar--danger')
    expect(bar.classes()).not.toContain('rail__bar--warn')
    wrapper.unmount()
  })

  it('leaves an unsampled host out of every band', async () => {
    const wrapper = await mountRail({ ...frame({ memory: 99, swap: 99, temp: 99 }), sampledAt: null })
    const bars = wrapper.findAll('.rail__bar')
    for (const bar of bars)
      expect(bar.classes().join(' ')).not.toMatch(/rail__bar--(?:danger|warn)/)
    wrapper.unmount()
  })
})
