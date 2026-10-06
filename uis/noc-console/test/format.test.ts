import { describe, expect, it } from 'vitest'
import { briefBytes, clamp, formatAgo, formatBytes, formatDuration, formatMs, formatMsHint, formatRatio, loadPerCpu, pct, relativeFrom, sparkPoints } from '../src/lib/format'

/**
 * `lib/format.ts` renders every number this UI shows, and had no test.
 *
 * `formatRatio` was the one function of its five siblings without a `Number.isFinite` guard, so it
 * rendered the literal `NaN%` where the others render the em-dash that means unknown. The type is
 * `number | null`, which permits a NaN, so the divergence was one producer change away from showing.
 */
describe('unknown is always the em-dash, never a literal NaN', () => {
  it('treats null and NaN alike, in every formatter that takes a nullable number', () => {
    // The siblings already agreed; `formatRatio` now does too (it rendered `NaN%`).
    for (const [name, fn] of [
      ['formatRatio', formatRatio],
      ['formatBytes', formatBytes],
      ['formatMs', formatMs],
      ['pct', pct],
    ] as const) {
      expect(fn(null), `${name}(null)`).toBe('—')
      expect(fn(Number.NaN), `${name}(NaN) is unknown, not a measurement`).toBe('—')
    }
  })

  it('briefBytes and formatAgo name their own unknown', () => {
    expect(briefBytes(null)).toBe('—')
    expect(formatAgo(null, 0)).toBe('never')
  })
})

describe('formatRatio', () => {
  it('drops the decimal once the value rounds to 100%', () => {
    expect(formatRatio(0)).toBe('0.0%')
    expect(formatRatio(0.5)).toBe('50.0%')
    expect(formatRatio(0.998)).toBe('99.8%')
    // 0.999 and up render without a decimal, so a healthy server reads "100%".
    expect(formatRatio(0.999)).toBe('100%')
    expect(formatRatio(1)).toBe('100%')
  })
})

describe('formatDuration and formatUptime-style rendering', () => {
  it('scales through the units a panel uptime lands in', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(1_000)).toBe('1s')
    expect(formatDuration(90_000)).toBe('1m 30s')
    expect(formatDuration(3_600_000)).toBe('1h 0m')
    expect(formatDuration(86_400_000)).toBe('1d 0h')
  })
})

describe('formatBytes', () => {
  it('switches unit at the boundary, and keeps zero as a size', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1 KiB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MiB')
    expect(formatBytes(1024 ** 3)).toBe('1.00 GiB')
  })
})

describe('formatMsHint', () => {
  it('reads a disabled duration as off rather than 0s', () => {
    // A config field set to 0 means "off", and "0s" would read as an instant rather than a switch.
    expect(formatMsHint(0)).toBe('off')
    expect(formatMsHint(-1)).toBe('off')
    expect(formatMsHint(Number.NaN)).toBe('off')
    expect(formatMsHint(90_000)).toBe('1m 30s')
  })
})

describe('formatAgo and relativeFrom', () => {
  it('never goes negative when the clock moves backwards', () => {
    // `now - ts` is negative if the server's clock is ahead; "-5s ago" would be nonsense.
    expect(formatAgo(2_000, 1_000)).toBe('0s ago')
    expect(formatAgo(1_000, 1_000)).toBe('0s ago')
    expect(formatAgo(1_000, 61_000)).toBe('1m ago')
  })

  it('relativeFrom counts *forward* to a future timestamp', () => {
    // It is a countdown to an expiry, not a signed offset: a moment already past clamps to "now"
    // rather than reporting a negative time.
    expect(relativeFrom(1_000, 1_000)).toBe('now')
    expect(relativeFrom(500, 1_000), 'a past moment is now, not negative').toBe('now')
    expect(relativeFrom(5_000, 1_000)).toBe('in 4s')
    expect(relativeFrom(121_000, 1_000)).toBe('in 2m')
  })
})

describe('clamp and loadPerCpu', () => {
  it('clamps to the closed range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })

  it('divides by at least one cpu, so an unknown count cannot divide by zero', () => {
    expect(loadPerCpu([2], 1)).toBe(2)
    expect(loadPerCpu([2], 0)).toBe(2)
    expect(loadPerCpu([], 4)).toBe(0)
  })
})

describe('sparkPoints', () => {
  it('produces one point per value and an empty string for none', () => {
    expect(sparkPoints([], 100, 20)).toBe('')
    const points = sparkPoints([0, 1, 2, 3], 100, 20)
    expect(points.split(' ')).toHaveLength(4)
  })

  it('survives a flat series, where a naive scale would divide by zero', () => {
    // Every value equal means max - min is 0; the line should still be drawable, not `NaN`.
    const flat = sparkPoints([5, 5, 5], 100, 20)
    expect(flat).not.toContain('NaN')
    expect(flat.split(' ')).toHaveLength(3)
  })
})
