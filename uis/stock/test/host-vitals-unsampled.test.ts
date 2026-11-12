// @vitest-environment happy-dom
import type { HostView } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import HostVitalsPanel from '../src/components/host/HostVitalsPanel.vue'
import InstrumentCluster from '../src/components/shell/InstrumentCluster.vue'
import { t } from '../src/i18n'

/**
 * The other UI prints the same frame, on two surfaces that are always on screen.
 *
 * `HostVitalsPanel` is the global overview's vitals card and `InstrumentCluster` sits in the
 * sidebar of every page. Both rendered `memoryUsedPercent` and `swapUsedPercent` straight off the
 * frame, so a panel that had not sampled yet — or one with host vitals switched off, whose frame
 * `emptyHostView()` keeps for ever — showed a `0%` memory dial and `0%` swap beside a load of
 * `0.00`, the picture of an idle machine. `/api/metrics` refuses the identical frame for the
 * identical reason (`test/api/panel.test.ts`: "publishes no host gauge before the host has been
 * sampled"), and noc-console's half is pinned by `uis/noc-console/test/host-vitals-unsampled.test.ts`.
 *
 * The dial has nothing to assert on a null but its own text, which is what a person reads, so
 * that is what this checks — plus the number the load line prints.
 */

/** A never-sampled frame: every value zero because the wire type says `number`. */
function unsampled(overrides: Partial<HostView> = {}): HostView {
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
    ...overrides,
  }
}

const sampled = (): HostView => unsampled({ sampledAt: 1_000_000, cpuUsedPercent: 12, memoryUsedPercent: 61.4, swapUsedPercent: 7.2, loadAvg: [2.5, 2, 1.5] })

describe('the stock host vitals panel', () => {
  it('shows no reading for a host that has never been sampled', () => {
    const wrapper = mount(HostVitalsPanel, { props: { host: unsampled(), now: 1_000_000 } })
    const text = wrapper.text()
    expect(text).not.toContain('0%')
    expect(text).not.toContain('0.00')
    // The cpu dial is the reference for how "no reading" already looked.
    expect(wrapper.findAll('span').some(node => node.text() === '—')).toBe(true)
    wrapper.unmount()
  })

  it('still prints the readings once the host has been sampled', () => {
    const wrapper = mount(HostVitalsPanel, { props: { host: sampled(), now: 1_000_000 } })
    const text = wrapper.text()
    expect(text).toContain('61%')
    expect(text).toContain('2.50  2.00  1.50')
    expect(text).toContain('0.31')
    wrapper.unmount()
  })

  it('keeps the "sampling off" empty state for a disabled sampler', () => {
    const wrapper = mount(HostVitalsPanel, { props: { host: unsampled({ enabled: false }), now: 1_000_000 } })
    expect(wrapper.text()).toContain(t('host.samplingOff'))
    wrapper.unmount()
  })
})

describe('the stock instrument cluster', () => {
  it('shows no number for a host that has never been sampled', () => {
    const wrapper = mount(InstrumentCluster, { props: { host: unsampled() } })
    const text = wrapper.text()
    // The memory dial is the one that used to read a fabricated 0%.
    expect(text).not.toContain('0%')
    expect(text).toContain('—')
    wrapper.unmount()
  })

  it('still prints the numbers once the host has been sampled', () => {
    const wrapper = mount(InstrumentCluster, { props: { host: sampled() } })
    expect(wrapper.text()).toContain('61%')
    expect(wrapper.text()).toContain('0.31')
    wrapper.unmount()
  })
})

/**
 * A reading the **platform** cannot take says so; it is not the same silence as "not sampled".
 *
 * Both render `—`, and they resolve differently: an unsampled frame resolves on the next sample,
 * while Windows' missing load average never will. Until this, a person on Windows saw `—` beside a
 * live memory reading with nothing to tell the two apart. `hostReadings` carries the names now.
 *
 * noc-console's half is `uis/noc-console/test/host-vitals-unsampled.test.ts`. The strings come from
 * the sheet, so they are asserted through `t()` — the same wording a reader gets.
 */
describe('the stock host vitals panel and a platform limit', () => {
  it('names the platform limit instead of leaving a bare dash', () => {
    // Windows: no load average. The rest of the sample is real.
    const wrapper = mount(HostVitalsPanel, {
      props: { host: { ...sampled(), loadAvg: [0, 0, 0], unmeasured: ['load'] }, now: 1_000_000 },
    })
    // Counted, not merely present: one note for the one limited reading. A second would mean the
    // taken readings were marked too, which a bare `toContain` cannot see.
    const note = t('host.unavailableReading')
    const occurrences = wrapper.text().split(note).length - 1
    expect(occurrences, 'exactly the load reading is marked').toBe(1)
    wrapper.unmount()
  })

  it('says nothing when the platform took every reading', () => {
    const wrapper = mount(HostVitalsPanel, { props: { host: sampled(), now: 1_000_000 } })
    expect(wrapper.text()).not.toContain(t('host.unavailableReading'))
    wrapper.unmount()
  })

  /**
   * With sampling switched off this card is the "sampling off" empty state, not a stale reading.
   *
   * The panel gates the whole body on `host.enabled`, so a held-back sample never reaches a number
   * here — which is why `lastSampled` is rendered by the *cluster*, not this card. Asserted so a
   * later refactor cannot start printing figures under a "sampling off" heading.
   */
  it('shows the sampling-off state rather than stale figures', () => {
    const wrapper = mount(HostVitalsPanel, { props: { host: unsampled({ sampledAt: 1_000_000, enabled: false }), now: 1_000_000 } })
    expect(wrapper.text()).toContain(t('host.samplingOff'))
    expect(wrapper.text()).not.toContain('0%')
    wrapper.unmount()
  })
})
