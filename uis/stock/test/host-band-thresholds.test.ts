// @vitest-environment happy-dom
import type { HostView } from '@shared/contracts'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import HostVitalsPanel from '../src/components/host/HostVitalsPanel.vue'
import InstrumentCluster from '../src/components/shell/InstrumentCluster.vue'

/**
 * The stock UI's host dials are verdicts on the thresholds the panel **notifies** on.
 *
 * `Gauge` and `Meter` default to `75`/`90` — `hostSchema`'s *default*. `HostVitalsPanel` also handed
 * the swap dial its own `:warn-at="50"` and scaled the temperature dial by `85`, and
 * `InstrumentCluster` let the disk dial take the defaults. Those are copies of a default: invisible
 * on a fresh config and wrong on any other one.
 *
 * Measured on the real components before the fix, with the frame `/api/state` really sends:
 *
 *     memory 92 against an alert raised to 95   -> stroke-danger   (no notification can fire)
 *     swap   60 against the shipped alert 50    -> stroke-warn     (the panel notifies here)
 *     disk   82 against an alert lowered to 80   -> stroke-warn    (the panel notifies here)
 *
 * `hostReadings` decides each band against the threshold the frame carries, so the dial reads it.
 * noc-console's half is pinned by `uis/noc-console/test/host-band-thresholds.test.ts`.
 */

/** A sampled frame whose readings sit at the given values, with the panel's thresholds. */
function frame(values: { memory?: number, swap?: number, temp?: number, disk?: number }, alerts: Partial<HostView> = {}): HostView {
  const diskUsed = values.disk
  return {
    enabled: true,
    cpus: 8,
    loadAvg: [0.1, 0.1, 0.1],
    cpuUsedPercent: 5,
    uptimeMs: 1000,
    memoryUsedPercent: values.memory ?? 10,
    swapUsedPercent: values.swap ?? 1,
    tempCelsius: values.temp ?? 40,
    disks: diskUsed === undefined
      ? []
      : [{ path: '/srv', totalBytes: 100, freeBytes: 100 - diskUsed, usedPercent: diskUsed }],
    alerts: [],
    sampledAt: 1_000_000,
    ...alerts,
  }
}

/** The stroke each dial draws, in render order: cpu, memory, [disk], temp. */
function dialTones(wrapper: ReturnType<typeof mount>): string[] {
  // The track is `stroke-line-soft`; the value arc is the second circle in each dial's svg.
  return wrapper.findAll('svg').map((svg) => {
    const arcs = svg.findAll('circle').filter(node => !(node.attributes('class') ?? '').includes('stroke-line-soft'))
    return arcs.map(arc => /stroke-(ok|warn|danger|faint|neutral)/.exec(arc.attributes('class') ?? '')?.[1] ?? '?').join(',')
  })
}

describe('the stock host panel bands each dial against its alert', () => {
  it('does not call memory a breach when the panel would not notify', () => {
    // 92% against a threshold a person raised to 95: close, but no notification fires.
    const wrapper = mount(HostVitalsPanel, { props: { host: frame({ memory: 92 }, { memoryUsedPercentAlert: 95 }), now: 1_000_000 } })
    expect(dialTones(wrapper)[1], 'memory dial against a raised alert').not.toBe('danger')
    wrapper.unmount()
  })

  it('paints danger at the swap threshold the panel notifies on, out of the box', () => {
    // `hostSchema` ships the swap alert at 50, so 60 is a breach and the dial must say so.
    const wrapper = mount(HostVitalsPanel, { props: { host: frame({ swap: 60 }, { swapUsedPercentAlert: 50 }), now: 1_000_000 } })
    expect(dialTones(wrapper)[2], 'swap dial at 60 against a 50 alert').toBe('danger')
    wrapper.unmount()
  })

  it('does not paint a temperature alarm for a threshold nobody will breach', () => {
    const wrapper = mount(HostVitalsPanel, { props: { host: frame({ temp: 90 }, { tempCelsiusAlert: 95 }), now: 1_000_000 } })
    expect(dialTones(wrapper)[3], 'temp dial at 90 against a 95 alert').not.toBe('danger')
    wrapper.unmount()
  })

  it('paints nothing alarming when the alert is switched off', () => {
    // `0` disables the alert in `sampleHost`, so there is no threshold to cross.
    const wrapper = mount(HostVitalsPanel, { props: { host: frame({ memory: 99 }, { memoryUsedPercentAlert: 0 }), now: 1_000_000 } })
    expect(dialTones(wrapper)[1], 'a switched-off memory alert').not.toBe('danger')
    wrapper.unmount()
  })
})

describe('the stock instrument cluster bands each dial against its alert', () => {
  it('paints the disk dial from the disk alert, not the component default', () => {
    // 82% against an alert a person lowered to 80 is a breach; the dial's default called it warn.
    const wrapper = mount(InstrumentCluster, { props: { host: frame({ disk: 82 }, { diskUsedPercentAlert: 80 }) } })
    expect(dialTones(wrapper)[2], 'disk dial at 82 against an 80 alert').toBe('danger')
    wrapper.unmount()
  })

  it('leaves a disk alone when the alert is switched off', () => {
    const wrapper = mount(InstrumentCluster, { props: { host: frame({ disk: 99 }, { diskUsedPercentAlert: 0 }) } })
    expect(dialTones(wrapper)[2], 'a switched-off disk alert').not.toBe('danger')
    wrapper.unmount()
  })

  it('does not call memory a breach when the panel would not notify', () => {
    const wrapper = mount(InstrumentCluster, { props: { host: frame({ memory: 92 }, { memoryUsedPercentAlert: 95 }) } })
    expect(dialTones(wrapper)[1], 'memory dial against a raised alert').not.toBe('danger')
    wrapper.unmount()
  })

  it('shows no dial colour for an unsampled host', () => {
    const wrapper = mount(InstrumentCluster, { props: { host: { ...frame({ memory: 99 }), sampledAt: null } } })
    for (const tone of dialTones(wrapper))
      expect(tone, 'an unsampled host has no verdict').not.toMatch(/danger|warn/)
    wrapper.unmount()
  })
})
