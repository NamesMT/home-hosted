// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Sparkline from '../src/components/Sparkline.vue'
import { sparkSegments } from '../src/lib/format'

/**
 * An absent reading is a gap in the chart, never a drawn zero.
 *
 * `AGENTS.md` states the rule for a rendered percent: an absent reading goes through a formatter
 * that prints `—`, because `0` is the value that looks like a measured idle process. The
 * noc-console's charts were the surface the rule did not reach: `sampleServer` wrote
 * `pushCapped(ring.cpu, live.cpuPercent ?? 0)`, the rings were typed `number[]`, and
 * `sparkPoints` could only draw a vertex per index. Measured on a stopped entry, the CPU spark on
 * the list, the detail page and the global overview was a **flat line at the floor** — the one
 * shape a reader cannot tell from a server measuring 0%.
 *
 * The stock UI already draws this correctly (`Sparkline.vue` there: "Null values break the line
 * instead of reading as zero"), which is why this is a rule the second UI did not follow rather
 * than a new idea. So the fix is the same shape in both charts: the series keeps the absence, and
 * the renderer splits into unbroken runs.
 */
describe('the sparkline breaks at an absent reading', () => {
  it('draws nothing at all for a series of absences', () => {
    // A stopped entry has no reading, so it has no line — not a line along the bottom.
    expect(sparkSegments([null, null], 92, 16)).toEqual([])
    expect(sparkSegments([], 92, 16)).toEqual([])
  })

  it('splits into one run per stretch of present values, so the gap is visible', () => {
    // 40, 30 then an absence then 20: a two-point run, a gap, a one-point run.
    const segments = sparkSegments([40, 30, null, 20], 90, 16)
    expect(segments).toHaveLength(2)
    // Two vertices in the first run, one in the second: the null is a break, not a vertex.
    expect(segments.map(segment => segment.line.split(' ').length)).toEqual([2, 1])
    // Each run's fill starts and ends on its own first and last sample, not on the box edges:
    // closing at the edges is what painted over the gap.
    expect(segments[0]!.area).toBe('0.00,16 0.00,1.00 30.00,4.50 30.00,16')
    expect(segments[1]!.area).toBe('90.00,16 90.00,8.00 90.00,16')
  })

  it('keeps every vertex on its own time step, so a gap does not squash the timeline', () => {
    // The chart's x-axis is the sample index. A break that re-numbered the surviving run would
    // draw the first sample after a gap at the left edge, as if no time had passed.
    const segments = sparkSegments([40, 30, null, 20], 90, 16)
    // Four samples, so the step is 30 px: the lone point of the second run sits at 3 * 30.
    expect(segments[1]!.line).toBe('90.00,8.00')
  })

  it('renders the gap rather than a zero vertex, through the component', () => {
    const wrapper = mount(Sparkline, { props: { values: [40, null, 30], width: 92, height: 16 } })
    // One polyline and one fill per unbroken run — the same count the segments promise.
    expect(wrapper.findAll('polyline')).toHaveLength(2)
    expect(wrapper.findAll('polygon')).toHaveLength(2)
    // No run may contain a point at the floor, which is what a zero coercion produced.
    for (const line of wrapper.findAll('polyline'))
      expect(line.attributes('points')!.split(' ').every(point => !point.endsWith(',15.00'))).toBe(true)
    wrapper.unmount()
  })

  it('says nothing is measured with a dashed baseline, not a line at zero', () => {
    const wrapper = mount(Sparkline, { props: { values: [null, null, null], width: 92, height: 16 } })
    expect(wrapper.findAll('polyline')).toHaveLength(0)
    expect(wrapper.find('.spark__empty').exists()).toBe(true)
    wrapper.unmount()
  })
})
