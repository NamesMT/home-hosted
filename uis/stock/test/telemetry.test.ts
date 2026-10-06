import type { ServerView } from '@shared/contracts'
import { describe, expect, it } from 'vitest'
import { createSeries, recordSample, SERIES_CAPACITY, seriesLast, seriesMax } from '../src/lib/telemetry'

/**
 * The resource charts are built client-side, so this module owns what they show.
 *
 * It had **no test at all** (5.71% statements, 0% branches): the ring buffer, the rule that decides
 * whether an SSE frame is a new sample or a fresher reading of the same one, and the two accessors all
 * ran unverified behind every chart in the panel.
 */

function view(overrides: Partial<ServerView> & { sampledAt?: number } = {}): ServerView {
  const { sampledAt = 1, ...rest } = overrides
  return {
    id: 'web',
    status: 'running',
    responseMs: 5,
    resources: { sampledAt, cpuPercent: 25, rssBytes: 1000, processes: 1 },
    ...rest,
  } as unknown as ServerView
}

describe('the telemetry ring buffer', () => {
  it('keeps every array the same length, and caps them together', () => {
    const series = createSeries()
    for (let i = 0; i < SERIES_CAPACITY + 25; i++)
      recordSample(series, view({ sampledAt: i, resources: { sampledAt: i, cpuPercent: i, rssBytes: i * 10, processes: 1 } } as never), 1000 + i * 5000)

    // A trim that dropped from one array only would misalign the chart's x and y.
    for (const values of [series.ts, series.cpu, series.rss, series.probe])
      expect(values.length).toBe(SERIES_CAPACITY)
    expect(series.ts.at(-1)).toBe(1000 + (SERIES_CAPACITY + 24) * 5000)
  })

  it('folds a frame about the same sample into the tip rather than pushing', () => {
    const series = createSeries()
    recordSample(series, view({ sampledAt: 1000 }), 10_000)
    const length = series.ts.length

    // Same `sampledAt`, inside the gap: not a new point, but the probe reading is newer.
    recordSample(series, { ...view({ sampledAt: 1000 }), responseMs: 99 } as ServerView, 10_500)
    expect(series.ts.length).toBe(length)
    expect(series.probe.at(-1)).toBe(99)
    expect(series.rss.at(-1)).toBe(1000)
  })

  it('takes a new point when the sample is new, or when the gap has passed', () => {
    const series = createSeries()
    recordSample(series, view({ sampledAt: 1000 }), 10_000)
    // A newer sample arriving almost immediately is still a new point.
    recordSample(series, view({ sampledAt: 2000 }), 10_500)
    expect(series.ts.length).toBe(2)
    // So is the same sample once the control plane's own 5s cadence has passed.
    recordSample(series, view({ sampledAt: 2000 }), 20_000)
    expect(series.ts.length).toBe(3)
  })

  it('records a stopped server as nulls rather than dropping the point', () => {
    const series = createSeries()
    recordSample(series, view({ status: 'stopped', resources: null }), 1)
    // The x-axis must advance so the gap is visible where the server was down.
    expect(series.ts).toEqual([1])
    expect(series.cpu).toEqual([null])
    expect(series.rss).toEqual([null])
    // A probe reading is kept even with no resources: it is the readiness latency.
    expect(series.probe).toEqual([5])
  })
})

describe('the series accessors', () => {
  it('report null-and-empty as null, and the newest value otherwise', () => {
    expect(seriesLast([])).toBeNull()
    expect(seriesLast([null, null])).toBeNull()
    expect(seriesLast([1, null, 3])).toBe(3)

    expect(seriesMax([])).toBe(0)
    expect(seriesMax([null, null])).toBe(0)
    expect(seriesMax([1, null, 3])).toBe(3)
  })
})
