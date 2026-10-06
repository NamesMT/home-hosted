import { describe, expect, it } from 'vitest'
import { formatAgo, formatClock, formatDuration, relativeFrom } from '#src/shared/ui-format'

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
    expect(formatDuration(3_600_000)).toBe('1h 0m')
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

  it('says how long ago, and never goes negative when the clock moves backwards', () => {
    expect(formatAgo(null, 0)).toBe('never')
    expect(formatAgo(2_000, 1_000), 'a future timestamp clamps').toBe('0s ago')
    expect(formatAgo(1_000, 61_000)).toBe('1m ago')
    // The deltas are `now - ts`, so the boundary is crossed by the *difference*, not `now` alone.
    expect(formatAgo(1_000, 1_000 + 3_600_000)).toBe('1h ago')
    expect(formatAgo(1_000, 1_000 + 3_599_999), 'just under an hour').toBe('59m ago')
    expect(formatAgo(1_000, 1_000 + 86_400_000)).toBe('1d ago')
  })

  it('renders a clock in 24-hour form', () => {
    // Locale-dependent, so asserted on shape rather than an exact string: `HH:MM:SS`.
    expect(formatClock(Date.UTC(2026, 0, 2, 3, 4, 5))).toMatch(/^\d{1,2}:\d{2}:\d{2}$/)
  })
})
