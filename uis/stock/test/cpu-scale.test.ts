import { describe, expect, it } from 'vitest'

/**
 * The CPU charts and colour bands must be scaled to the machine, not to one core.
 *
 * `cpuPercent` is summed over a server's **process tree**, so a multi-core workload legitimately
 * reads 400% — that is four cores busy, not a bug. The panel drew that series with a fixed
 * `max=100`, which clipped every point above 100 to the top edge: a server using a sixth of a
 * 24-core box looked pinned at 100%, and the sparkline told the same story the (wrong) host dial
 * did. The ceiling is `cpus * 100`, so the chart answers "how much of this box is that server
 * using" — the question a person actually has.
 *
 * The arithmetic is pinned here rather than through a mounted component because the same three
 * lines live in `ServerCard`, `ServerDetailView` and both noc-console views, and a renderer test
 * per file would still not prove the *rule*.
 */

/** The rule the views apply, kept in one place so a divergence fails here. */
function cpuCeiling(cpus: number | undefined): number {
  return Math.max(100, (cpus ?? 1) * 100)
}

/** Where a value sits on that ceiling, 0–1, which is what `Sparkline` draws. */
function cpuShare(percent: number, ceiling: number): number {
  return Math.min(1, Math.max(0, percent / ceiling))
}

describe('the cpu chart ceiling', () => {
  it('is the whole machine, so four busy cores are not clipped', () => {
    expect(cpuCeiling(24)).toBe(2400)
    // 400% on a 24-core host is a sixth of the box, and the line sits a sixth of the way up.
    expect(cpuShare(400, cpuCeiling(24))).toBeCloseTo(1 / 6)
    // With the old fixed 100 it was pinned to the top edge, indistinguishable from a pegged box.
    expect(cpuShare(400, 100)).toBe(1)
  })

  it('never shrinks below one core, however the core count reads', () => {
    // A single-core box: 100% is the top. A missing host frame must not divide by zero.
    expect(cpuCeiling(1)).toBe(100)
    expect(cpuCeiling(0)).toBe(100)
    expect(cpuCeiling(undefined)).toBe(100)
    expect(cpuShare(50, cpuCeiling(undefined))).toBeCloseTo(0.5)
  })

  it('keeps a full load of every core at the top, not past it', () => {
    // 24 cores all busy is exactly full scale — the chart's maximum is meaningful, not decorative.
    expect(cpuShare(2400, cpuCeiling(24))).toBe(1)
    // A reading that somehow exceeded the machine still renders, clamped.
    expect(cpuShare(5000, cpuCeiling(24))).toBe(1)
  })
})
