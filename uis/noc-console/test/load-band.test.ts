// @vitest-environment happy-dom
import type { HostView } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

/**
 * The load colour is a verdict on the threshold the panel itself notifies on.
 *
 * `HostVitals`' own docstring says the bands "follow the configured alert threshold (default
 * 2/cpu), which is the number the panel itself notifies on" — and the body compared against the
 * literals `2` and `1.4`, as did `HostRail`. Both surfaces read the state frame, which carried no
 * threshold, so raising `host.loadPerCpu` to 4 in Settings left the tile painting a healthy box
 * `danger` at 2.5 while the notification that threshold governs stayed silent.
 *
 * Pinned by driving the real component: the frame it is given is exactly what `/api/state` sends.
 */

const host = ref<HostView | null>(null)

vi.mock('@/composables/useControlPlane', () => ({
  useControlPlane: () => ({
    host,
    now: ref(1_000_000),
    // The rail reads the panel's own address and exposure for its status cell.
    control: ref({ url: 'http://127.0.0.1:3999', auth: { exposed: false } }),
  }),
}))

/** A sampled frame at one per-cpu load, with the alert threshold the panel would notify on. */
function frame(loadPerCpu: number, alertPerCpu?: number): HostView {
  return {
    enabled: true,
    cpus: 8,
    loadAvg: [loadPerCpu * 8, loadPerCpu * 8, loadPerCpu * 8],
    cpuUsedPercent: 12,
    uptimeMs: 1000,
    memoryUsedPercent: 61.4,
    swapUsedPercent: 7.2,
    tempCelsius: 41,
    disks: [],
    alerts: [],
    sampledAt: 1_000_000,
    ...(alertPerCpu === undefined ? {} : { loadAlertPerCpu: alertPerCpu }),
  }
}

async function mountVitals(view: HostView) {
  host.value = view
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

async function mountRail(view: HostView) {
  host.value = view
  const HostRail = (await import('../src/components/HostRail.vue')).default
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  return mount(HostRail, { global: { plugins: [router] } })
}

beforeEach(() => {
  host.value = null
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the per-cpu load band follows the alert threshold', () => {
  it('leaves a reading below a raised threshold uncoloured, because the panel will not notify', async () => {
    const wrapper = await mountVitals(frame(2.5, 4))
    const value = tile(wrapper, 'per cpu')!.find('.metric__v')
    expect(value.classes(), 'a box a person raised the threshold on').not.toContain('metric__v--danger')
    expect(value.classes(), 'a box a person raised the threshold on').not.toContain('metric__v--warn')
    wrapper.unmount()
  })

  it('still paints a reading past the threshold the panel notifies on', async () => {
    const wrapper = await mountVitals(frame(4.2, 4))
    const value = tile(wrapper, 'per cpu')!.find('.metric__v')
    expect(value.classes()).toContain('metric__v--danger')
    wrapper.unmount()
  })

  it('keeps the default band for a config that left the threshold alone', async () => {
    const wrapper = await mountVitals(frame(2.5, 2))
    expect(tile(wrapper, 'per cpu')!.find('.metric__v').classes()).toContain('metric__v--danger')
    wrapper.unmount()
  })

  it('paints nothing alarming when the alert is switched off', async () => {
    // `0` disables the alert in `sampleHost`, so there is no threshold to cross.
    const wrapper = await mountVitals(frame(9, 0))
    const value = tile(wrapper, 'per cpu')!.find('.metric__v')
    expect(value.classes()).not.toContain('metric__v--danger')
    expect(value.classes()).not.toContain('metric__v--warn')
    wrapper.unmount()
  })

  it('reads the same threshold in the rail, which is on every page', async () => {
    const raised = await mountRail(frame(2.5, 4))
    const raisedBar = raised.findAll('.rail__cell')[1]!.find('.rail__bar')
    expect(raisedBar.classes(), 'the rail beside the raised threshold').not.toContain('rail__bar--danger')
    raised.unmount()

    const tight = await mountRail(frame(2.5, 2))
    expect(tight.findAll('.rail__cell')[1]!.find('.rail__bar').classes()).toContain('rail__bar--danger')
    tight.unmount()
  })

  it('leaves an unsampled host dim rather than in a band', async () => {
    const wrapper = await mountVitals({ ...frame(0), sampledAt: null, alerts: [] })
    expect(tile(wrapper, 'per cpu')!.find('.metric__v').classes()).toContain('metric__v--dim')
    wrapper.unmount()
  })
})
