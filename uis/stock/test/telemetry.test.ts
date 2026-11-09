import { describe, expect, it } from 'vitest'
import { seriesLast, seriesMax } from '../src/lib/telemetry'

/** The ring buffer itself is shared now and tested in `test/shared/live-series.test.ts`. */
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
