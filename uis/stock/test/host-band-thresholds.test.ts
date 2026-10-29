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

/**
 * The temperature dial's **full scale** is the threshold, and one surface was still dividing by a
 * literal.
 *
 * `InstrumentCluster` was fixed to scale the dial by `tempCelsiusAlert`; `HostVitalsPanel` kept
 * `(readings.tempCelsius / 85) * 100` in its template. Both paint the same reading, so with the
 * alert raised to 95 the two surfaces drew the *same* 60 °C at different arc lengths — the card's
 * dial fuller than the rail's, for one number. Measured on the real components before the fix:
 * the panel's temp arc was `113.10` and the cluster's `101.19` on an identical frame.
 *
 * The tone tests above could not see it: the colour comes from `tempBand`, which was already
 * correct, so a wrong scale left every verdict right and only the needle wrong.
 */
describe('both stock surfaces draw the temperature dial on the same scale', () => {
  /**
   * The value arc's dash length, which is the only thing that shows a dial's scale.
   *
   * A dial is the last `svg` that draws one: lucide icons are `svg`s too, and one of them sits in
   * the vitals card's own detail list, so picking the last `svg` on the page read an icon.
   */
  function tempArc(wrapper: ReturnType<typeof mount>): number {
    const dials = wrapper.findAll('svg').filter(svg => svg.findAll('circle').some(node => node.attributes('stroke-dasharray') !== undefined))
    const svg = dials[dials.length - 1]!
    const arc = svg.findAll('circle').find(node => !(node.attributes('class') ?? '').includes('stroke-line-soft'))
    return Number.parseFloat((arc?.attributes('stroke-dasharray') ?? '0').split(' ')[0]!)
  }

  it('draws one reading the same on the card and in the rail', () => {
    // 60 °C against an alert raised to 95: the scale is 95, not the schema default of 85.
    const panel = mount(HostVitalsPanel, { props: { host: frame({ temp: 60 }, { tempCelsiusAlert: 95 }), now: 1_000_000 } })
    const cluster = mount(InstrumentCluster, { props: { host: frame({ temp: 60 }, { tempCelsiusAlert: 95 }) } })
    expect(tempArc(panel), 'the vitals card against the rail, one frame').toBe(tempArc(cluster))
    panel.unmount()
    cluster.unmount()
  })

  it('draws half the dial at half the threshold a person configured', () => {
    // The alert fires at 95, so 47.5 °C is half of it — a quarter of the 270° sweep.
    const panel = mount(HostVitalsPanel, { props: { host: frame({ temp: 47.5 }, { tempCelsiusAlert: 95 }), now: 1_000_000 } })
    const cluster = mount(InstrumentCluster, { props: { host: frame({ temp: 47.5 }, { tempCelsiusAlert: 95 }) } })
    // A full sweep is 0.75 of the circumference, `2 * π * 34`.
    const half = 0.5 * 0.75 * 2 * Math.PI * 34
    expect(tempArc(panel), 'the vitals card').toBeCloseTo(half, 5)
    expect(tempArc(cluster), 'the rail').toBeCloseTo(half, 5)
    panel.unmount()
    cluster.unmount()
  })

  it('keeps the default scale for a panel that sends no temperature threshold', () => {
    // An older panel alerted on the schema default of 85, so that is the scale it is drawn on.
    const panel = mount(HostVitalsPanel, { props: { host: frame({ temp: 60 }), now: 1_000_000 } })
    const cluster = mount(InstrumentCluster, { props: { host: frame({ temp: 60 }) } })
    expect(tempArc(panel), 'no threshold on the frame').toBe(tempArc(cluster))
    panel.unmount()
    cluster.unmount()
  })
})

/**
 * The host cpu share has no configurable alert, so its band is a shared decision.
 *
 * `hostSchema` has no cpu threshold — nothing a person chose — so the band is fixed by nature. It
 * was fixed *twice*: noc-console painted 70/90 and every stock dial 80/95, so one 75% reading came
 * back `warn` on one page and `ok` on the other. That is `AGENTS.md`'s "UIs move together" broken by
 * two literal pairs, and no test could see it because each side was self-consistent.
 */
describe('the cpu band is one decision', () => {
  const CPU_AT_75: HostView = {
    enabled: true,
    cpus: 8,
    loadAvg: [0, 0, 0],
    cpuUsedPercent: 75,
    uptimeMs: 1000,
    memoryUsedPercent: 10,
    swapUsedPercent: 1,
    tempCelsius: 40,
    disks: [],
    alerts: [],
    sampledAt: 1_000_000,
  }

  /** The colour of one dial, found by the label it prints under it. */
  function cpuStroke(wrapper: ReturnType<typeof mount>): string {
    const dial = wrapper.findAll('div').find(node => node.find('span').exists() && node.text().endsWith('CPU usage'))
      ?? wrapper.findAll('div').find(node => node.text().includes('CPU usage'))
    expect(dial, 'no cpu dial on this surface').toBeDefined()
    // The value arc is the second circle; the first is the `stroke-line-soft` track.
    const strokes = dial!.findAll('circle').map(circle => circle.attributes('class') ?? '').filter(name => /stroke-(?!line-soft)/.test(name))
    return strokes[0] ?? ''
  }

  it('bands a 75% share the same way on the stock card and in the cluster', () => {
    const card = mount(HostVitalsPanel, { props: { host: CPU_AT_75, now: 1_000_000 } })
    const cluster = mount(InstrumentCluster, { props: { host: CPU_AT_75 } })

    const onCard = cpuStroke(card)
    expect(onCard, 'the card and the cluster must agree').toBe(cpuStroke(cluster))
    // 75 sits under the shared warn line, so neither paints it.
    expect(onCard, '75% is below the band this package chose').not.toMatch(/stroke-(?:warn|danger)/)

    card.unmount()
    cluster.unmount()
  })

  it('paints danger at the shared line, on both', () => {
    const host = { ...CPU_AT_75, cpuUsedPercent: 96 }
    const card = mount(HostVitalsPanel, { props: { host, now: 1_000_000 } })
    const cluster = mount(InstrumentCluster, { props: { host } })
    expect(cpuStroke(card)).toContain('stroke-danger')
    expect(cpuStroke(cluster)).toContain('stroke-danger')
    card.unmount()
    cluster.unmount()
  })
})
