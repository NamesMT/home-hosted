import { describe, expect, it } from 'vitest'
import { formatAgo, formatClock, formatDuration, formatRatio, relativeFrom } from '#src/shared/ui-format'

/**
 * The four formatters both UIs share.
 *
 * They were byte-identical copies in `uis/stock/src/lib/format.ts` and
 * `uis/noc-console/src/lib/format.ts` — 911 duplicated characters — and the cost showed: fixing
 * `formatRatio`'s missing `Number.isFinite` guard in one UI left the other still rendering `NaN%`.
 * `proxy-form.ts` was created for exactly this reason; this is the same fix for the same class.
 */
describe('shared UI formatting', () => {
  it('renders a duration as its two largest units', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(1_000)).toBe('1s')
    expect(formatDuration(90_000)).toBe('1m 30s')
    expect(formatDuration(3_600_000)).toBe('1h')
    expect(formatDuration(90_000_000)).toBe('1d 1h')
  })

  it('reads a nonsensical duration as unknown rather than a negative span', () => {
    expect(formatDuration(Number.NaN)).toBe('—')
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('counts forward to an expiry, clamping a past moment to now', () => {
    expect(relativeFrom(1_000, 1_000)).toBe('now')
    expect(relativeFrom(500, 1_000), 'a past moment is never negative').toBe('now')
    expect(relativeFrom(5_000, 1_000)).toBe('in 4s')
    expect(relativeFrom(121_000, 1_000)).toBe('in 2m')
  })

  /**
   * The countdown climbs the same s/m/h/d ladder `formatAgo` does.
   *
   * It stopped at minutes, so a job due tomorrow morning rendered `in 694m` — the Jobs page's
   * **Next** column, where every row past an hour needed dividing by 60 to mean anything. noc-console
   * already grouped those by hand (`in 12 hours`), which is how the two UIs disagreed about one
   * number.
   */
  it('climbs to hours and days on a long countdown', () => {
    expect(relativeFrom(1_000 + 3_600_000, 1_000), 'an hour').toBe('in 1h')
    expect(relativeFrom(1_000 + 19_980_000, 1_000), 'just over 5h20m rounds up').toBe('in 6h')
    expect(relativeFrom(1_000 + 3_599_999, 1_000), 'just under an hour stays minutes').toBe('in 60m')
    expect(relativeFrom(1_000 + 41_640_000, 1_000), 'just under 12h').toBe('in 12h')
    expect(relativeFrom(1_000 + 86_400_000, 1_000), 'a day').toBe('in 1d')
  })

  it('says how long ago, and never goes negative when the clock moves backwards', () => {
    expect(formatAgo(null, 0)).toBe('never')
    expect(formatAgo(2_000, 1_000), 'a future timestamp clamps').toBe('0s ago')
    expect(formatAgo(1_000, 61_000)).toBe('1m ago')
    // The deltas are `now - ts`, so the boundary is crossed by the *difference*, not `now` alone.
    expect(formatAgo(1_000, 1_000 + 3_600_000)).toBe('1h ago')
    expect(formatAgo(1_000, 1_000 + 3_599_999), 'just under an hour').toBe('59m ago')
    expect(formatAgo(1_000, 1_000 + 86_400_000)).toBe('1d ago')
  })

  /**
   * Unknown reads as an em-dash, never the literal `NaN%`.
   *
   * This function is why the module exists: its `!Number.isFinite` guard was added to one UI and not
   * the other, so the same server showed `NaN%` in `stock` and `—` in `noc-console`. Both copies were
   * identical once both had the guard, which is when it moved here.
   */
  it('renders a ratio, and refuses to print NaN', () => {
    expect(formatRatio(0)).toBe('0.0%')
    expect(formatRatio(0.5)).toBe('50.0%')
    expect(formatRatio(0.998)).toBe('99.8%')
    // 0.999 and up drop the decimal, so a healthy server reads "100%".
    expect(formatRatio(0.999)).toBe('100%')
    expect(formatRatio(1)).toBe('100%')
    expect(formatRatio(null)).toBe('—')
    expect(formatRatio(Number.NaN), 'unknown, not a measurement').toBe('—')
    expect(formatRatio(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('renders a clock in 24-hour form', () => {
    // Locale-dependent, so asserted on shape rather than an exact string: `HH:MM:SS`.
    expect(formatClock(Date.UTC(2026, 0, 2, 3, 4, 5))).toMatch(/^\d{1,2}:\d{2}:\d{2}$/)
  })
})
