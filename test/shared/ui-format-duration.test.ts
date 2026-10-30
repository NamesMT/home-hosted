import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { settingsPatchSchema, workspaceSettingsPatchSchema } from '#src/shared/contracts'
import { msToSeconds, readSeconds, secondsToMs, secondsToMsOr, shownInSeconds } from '#src/shared/ui-format'

/**
 * Milliseconds in the config, seconds in the box.
 *
 * Every duration field whose schema floor is a second — session lifetime (60 s), lockout (1 s),
 * vitals interval (5 s), notification cooldown, DDNS check — was edited as a raw millisecond count,
 * so the page showed `604800000` for a week. The config keeps `ms` (changing it would be a migration
 * for no gain); only the widget converts.
 */
describe('durations shown in seconds', () => {
  it('converts both ways at the whole-second boundary', () => {
    expect(msToSeconds(60_000)).toBe(60)
    expect(msToSeconds(604_800_000)).toBe(604_800)
    expect(secondsToMs(60)).toBe(60_000)
    expect(secondsToMs(604_800)).toBe(604_800_000)
  })

  it('rounds a stray millisecond, and the round trip is what the page relies on', () => {
    // A config hand-edited to `1500` reads `2s`. That is the only lossy case, and it is why only a
    // *change* writes: opening the page shows 2, and the field is untouched until someone types.
    expect(msToSeconds(1500)).toBe(2)
    // The values a person actually sets survive exactly, which is what keeps a visit non-destructive.
    for (const seconds of [1, 5, 15, 60, 300, 3600, 604_800]) {
      const ms = secondsToMs(seconds)
      expect(msToSeconds(ms), `${seconds}s must round-trip`).toBe(seconds)
    }
  })

  it('decides by the schema floor, so a sub-second field is never rounded away', () => {
    // `health.timeoutMs` starts at 100 and `health.intervalMs` at 500: a seconds box would collapse
    // the whole accepted range, so those stay in ms.
    expect(shownInSeconds(100)).toBe(false)
    expect(shownInSeconds(500)).toBe(false)
    // A one-second floor is the first field with no meaningful sub-second value.
    expect(shownInSeconds(1000)).toBe(true)
    expect(shownInSeconds(5000)).toBe(true)
    expect(shownInSeconds(60_000)).toBe(true)
  })

  it('keeps zero at zero, which is a real value for cooldown and force-restart', () => {
    expect(msToSeconds(0)).toBe(0)
    expect(secondsToMs(0)).toBe(0)
  })
})

/**
 * A cleared seconds box, read through the shared helper.
 *
 * The boxes that carry the conversion are `:value`/`@input`, so their read-back is hand-written —
 * and the shape that came out of that was `secondsToMs(Number($event.target.value))`, whose answer
 * for `''` is `0`. For `sessionTtlMs` (floor 60 s) that is a page save the schema refuses; for the
 * notification throttle, whose "off" sentinel is also `0`, it silently disables it.
 */
describe('a seconds box nobody filled in', () => {
  it('reports nothing decided for a blank or unreadable box', () => {
    expect(readSeconds('')).toBeNaN()
    expect(readSeconds('   ')).toBeNaN()
    expect(readSeconds('soon')).toBeNaN()
    expect(readSeconds(null)).toBeNaN()
    expect(readSeconds(undefined)).toBeNaN()
  })

  it('reads a real count, zero included', () => {
    expect(readSeconds('60')).toBe(60)
    expect(readSeconds(' 120 ')).toBe(120)
    // Zero is a setting in its own right — the throttle's off sentinel, and `lockout`'s floor.
    expect(readSeconds('0')).toBe(0)
  })

  it('keeps the stored value when the box decided nothing', () => {
    const live = 604_800_000
    expect(secondsToMsOr(readSeconds(''), live)).toBe(live)
    expect(secondsToMsOr(readSeconds('soon'), live)).toBe(live)
    expect(secondsToMsOr(null, live)).toBe(live)
    expect(secondsToMsOr(undefined, live)).toBe(live)
    expect(secondsToMsOr(Number.NaN, live)).toBe(live)
  })

  it('converts a real count, and leaves zero as zero', () => {
    expect(secondsToMsOr(readSeconds('30'), 604_800_000)).toBe(30_000)
    expect(secondsToMsOr(0, 120_000)).toBe(0)
  })

  it('produces a body the panel accepts where the coercion refused it', () => {
    // The two shapes the pages had, against the floors that make the difference visible.
    expect(settingsPatchSchema({ control: { auth: { sessionTtlMs: secondsToMsOr(readSeconds(''), 604_800_000) } } }))
      .not
      .toBeInstanceOf(type.errors)
    expect(workspaceSettingsPatchSchema({ notifications: { defaults: { cooldownMs: secondsToMsOr(readSeconds(''), 120_000) } } }))
      .not
      .toBeInstanceOf(type.errors)
  })
})
