import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { cronClock, cronDueAt, cronProblem, cronSummary, nextCronRun, parseCron, previousCronRun } from '#src/shared/cron'

/**
 * The 5-field parser the schedule field and the scheduler both use.
 *
 * Every expectation is built from a **local** `new Date(...)`, which is the same wall clock the
 * parser reads — so a suite run in any timezone asserts the same wall-clock behaviour, and a test
 * that pinned a UTC string would pass on a UTC machine and fail on the one that matters.
 */

function spec(expression: string) {
  const parsed = parseCron(expression)
  if (!parsed.ok)
    throw new Error(`expected "${expression}" to parse: ${parsed.problem}`)
  return parsed.spec
}

/** A local wall-clock time, which is what every date in this file means. */
function local(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0)
}

describe('parseCron', () => {
  it('reads the five fields, with `*` as the whole range', () => {
    const parsed = spec('* * * * *')
    expect(parsed.minutes.size).toBe(60)
    expect(parsed.hours.size).toBe(24)
    expect(parsed.daysOfMonth.size).toBe(31)
    expect(parsed.months.size).toBe(12)
    expect(parsed.daysOfWeek.size).toBe(7)
    expect(parsed.domRestricted).toBe(false)
    expect(parsed.dowRestricted).toBe(false)
  })

  it('reads ranges, steps, lists and every mixture of them', () => {
    expect([...spec('1-5 * * * *').minutes].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
    expect([...spec('*/5 * * * *').minutes].sort((a, b) => a - b)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
    // A step over a range starts at its low end, which is what `1-10/2` means and what GNU cron does.
    expect([...spec('1-10/2 * * * *').minutes].sort((a, b) => a - b)).toEqual([1, 3, 5, 7, 9])
    expect([...spec('1,3,5 * * * *').minutes].sort((a, b) => a - b)).toEqual([1, 3, 5])
    // A bare number with a step is `n-max/step`.
    expect([...spec('5/20 * * * *').minutes].sort((a, b) => a - b)).toEqual([5, 25, 45])
    // Two lists merge, and a duplicate is harmless.
    expect([...spec('1,3-4,3 * * * *').minutes].sort((a, b) => a - b)).toEqual([1, 3, 4])
  })

  it('reads month and weekday names, case-insensitively', () => {
    expect([...spec('0 0 1 jan *').months]).toEqual([1])
    expect([...spec('0 0 1 JAN,Dec *').months].sort((a, b) => a - b)).toEqual([1, 12])
    expect([...spec('0 0 * * mon').daysOfWeek]).toEqual([1])
    expect([...spec('0 0 * * Sun,Sat').daysOfWeek].sort((a, b) => a - b)).toEqual([0, 6])
    // A range of names, which is how a workday schedule is written.
    expect([...spec('0 9 * * mon-fri').daysOfWeek].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('folds Sunday 7 into Sunday 0, so one day has one number', () => {
    expect([...spec('0 0 * * 7').daysOfWeek]).toEqual([0])
    expect([...spec('0 0 * * 0,7').daysOfWeek]).toEqual([0])
    // The whole range including both ends is still seven days, not eight.
    expect(spec('0 0 * * 0-7').daysOfWeek.size).toBe(7)
  })

  it('refuses a 6-field expression, naming how many fields an expression has', () => {
    const parsed = parseCron('0 0 0 * * *')
    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? '' : parsed.problem).toMatch(/5 fields/)
    expect(parsed.ok ? '' : parsed.problem).toMatch(/has 6/)
    // Four is the other side of the same mistake.
    expect(parseCron('0 0 * *').ok).toBe(false)
  })

  it('refuses a macro, and says this release takes 5 fields', () => {
    for (const macro of ['@reboot', '@daily', '@hourly', '@every 5m']) {
      const parsed = parseCron(macro)
      expect(parsed.ok, macro).toBe(false)
      expect(parsed.ok ? '' : parsed.problem, macro).toMatch(/5-field/)
    }
  })

  it('refuses an empty schedule, a bad number, a backwards range and an unknown name', () => {
    expect(parseCron('').ok).toBe(false)
    expect(parseCron('   ').ok).toBe(false)

    const outOfRange = parseCron('60 * * * *')
    expect(outOfRange.ok).toBe(false)
    expect(outOfRange.ok ? '' : outOfRange.problem).toMatch(/minute must be between 0 and 59/)

    const backwards = parseCron('0 0 * * fri-mon')
    expect(backwards.ok).toBe(false)
    expect(backwards.ok ? '' : backwards.problem).toMatch(/counts backwards/)

    const misspelt = parseCron('0 0 * jnu *')
    expect(misspelt.ok).toBe(false)
    expect(misspelt.ok ? '' : misspelt.problem).toMatch(/jnu/)

    // A name in a field with no names is a typo too, not a silent zero.
    expect(parseCron('0 0 mon * *').ok).toBe(false)
    // A zero step never comes due, so it is refused rather than left silent.
    expect(parseCron('*/0 * * * *').ok).toBe(false)
    // An empty element between commas is not "all of them".
    expect(parseCron('1,,2 * * * *').ok).toBe(false)
    // Three bounds is not a range.
    expect(parseCron('1-2-3 * * * *').ok).toBe(false)
  })

  it('tolerates the whitespace a person pastes', () => {
    expect(parseCron('  0   3  *  *  * ').ok).toBe(true)
    expect(parseCron('0\t3\t*\t*\t*').ok).toBe(true)
  })
})

describe('cronDueAt', () => {
  it('matches a minute inside the set and not one outside it', () => {
    const daily = spec('0 3 * * *')
    expect(cronDueAt(daily, local(2026, 3, 10, 3, 0))).toBe(true)
    expect(cronDueAt(daily, local(2026, 3, 10, 3, 1))).toBe(false)
    expect(cronDueAt(daily, local(2026, 3, 10, 4, 0))).toBe(false)
  })

  it('matches a name range, a step and a month restriction', () => {
    const workday = spec('30 9 * * mon-fri')
    expect(cronDueAt(workday, local(2026, 3, 10, 9, 30))).toBe(true) // a Tuesday
    expect(cronDueAt(workday, local(2026, 3, 14, 9, 30))).toBe(false) // a Saturday
    expect(cronDueAt(workday, local(2026, 3, 10, 9, 31))).toBe(false)

    const quarters = spec('0 0 1 1,4,7,10 *')
    expect(cronDueAt(quarters, local(2026, 4, 1, 0, 0))).toBe(true)
    expect(cronDueAt(quarters, local(2026, 5, 1, 0, 0))).toBe(false)

    const everyFive = spec('*/5 * * * *')
    expect(cronDueAt(everyFive, local(2026, 3, 10, 11, 25))).toBe(true)
    expect(cronDueAt(everyFive, local(2026, 3, 10, 11, 26))).toBe(false)
  })

  it('treats the two day fields as an OR when both are restricted, and an AND for a lone one when both are restricted, and ANDs a lone one', () => {
    // First of the month, or any Monday: Vixie cron's rule, which is what a person writing this means.
    const either = spec('0 0 1 * mon')
    expect(cronDueAt(either, local(2026, 3, 1, 0, 0)), 'the 1st').toBe(true)
    expect(cronDueAt(either, local(2026, 3, 9, 0, 0)), 'a Monday').toBe(true)
    expect(cronDueAt(either, local(2026, 3, 10, 0, 0)), 'a Tuesday that is not the 1st').toBe(false)

    // Only the month's day is restricted: the weekday is a wildcard, and AND with it changes nothing.
    const firstOnly = spec('0 0 1 * *')
    expect(cronDueAt(firstOnly, local(2026, 3, 1, 0, 0))).toBe(true)
    expect(cronDueAt(firstOnly, local(2026, 3, 2, 0, 0))).toBe(false)

    // Only the weekday is restricted, likewise.
    const mondayOnly = spec('0 0 * * mon')
    expect(cronDueAt(mondayOnly, local(2026, 3, 9, 0, 0))).toBe(true)
    expect(cronDueAt(mondayOnly, local(2026, 3, 10, 0, 0))).toBe(false)
  })
})

describe('nextCronRun', () => {
  it('finds the next minute after `from`, never `from` itself', () => {
    const everyMinute = spec('* * * * *')
    expect(nextCronRun(everyMinute, local(2026, 3, 10, 3, 0))).toBe(local(2026, 3, 10, 3, 1).getTime())

    // At 02:59 the next `0 3 * * *` is 03:00 the same day.
    const daily = spec('0 3 * * *')
    expect(nextCronRun(daily, local(2026, 3, 10, 2, 59))).toBe(local(2026, 3, 10, 3, 0).getTime())
    // At 03:00 the same minute is already handled, so the answer is tomorrow — a scheduler that
    // re-reported it would run the job twice for one occurrence.
    expect(nextCronRun(daily, local(2026, 3, 10, 3, 0))).toBe(local(2026, 3, 11, 3, 0).getTime())
  })

  it('crosses a day, a month and a year boundary', () => {
    const monthly = spec('0 0 1 * *')
    expect(nextCronRun(monthly, local(2026, 3, 15, 12, 0))).toBe(local(2026, 4, 1, 0, 0).getTime())
    expect(nextCronRun(monthly, local(2026, 12, 15, 12, 0))).toBe(local(2027, 1, 1, 0, 0).getTime())
  })

  it('finds a weekday range and a stepped hour', () => {
    const workday = spec('30 9 * * mon-fri')
    // Friday 10:00 → Monday 09:30.
    expect(nextCronRun(workday, local(2026, 3, 13, 10, 0))).toBe(local(2026, 3, 16, 9, 30).getTime())
    // Every two hours on the hour.
    const everyTwo = spec('0 */2 * * *')
    expect(nextCronRun(everyTwo, local(2026, 3, 10, 3, 10))).toBe(local(2026, 3, 10, 4, 0).getTime())
  })

  it('answers null for a day that cannot occur, rather than looping', () => {
    // 31 April never comes; the search stops rather than crawling for ever.
    expect(nextCronRun(spec('0 0 31 4 *'), local(2026, 3, 10, 0, 0))).toBeNull()
  })

  it('finds 29 February when the year has one', () => {
    expect(nextCronRun(spec('0 0 29 2 *'), local(2026, 3, 10, 0, 0))).toBe(local(2028, 2, 29, 0, 0).getTime())
  })
})

describe('previousCronRun', () => {
  it('reports the occurrence due now, not the next one', () => {
    const daily = spec('0 3 * * *')
    // Exactly at the occurrence: this is the one that is due.
    expect(previousCronRun(daily, local(2026, 3, 10, 3, 0))).toBe(local(2026, 3, 10, 3, 0).getTime())
    // A second later still means that occurrence, which is what makes the tick interval irrelevant.
    expect(previousCronRun(daily, local(2026, 3, 10, 3, 0))).toBe(local(2026, 3, 10, 3, 0).getTime())
    // Before it, the answer is yesterday's.
    expect(previousCronRun(daily, local(2026, 3, 10, 2, 59))).toBe(local(2026, 3, 9, 3, 0).getTime())
  })

  it('ignores the seconds inside the minute', () => {
    const everyMinute = spec('* * * * *')
    const at = new Date(local(2026, 3, 10, 3, 5).getTime() + 47_000)
    expect(previousCronRun(everyMinute, at)).toBe(local(2026, 3, 10, 3, 5).getTime())
  })

  it('round-trips with nextCronRun', () => {
    const weekly = spec('15 4 * * sun')
    const from = local(2026, 3, 10, 12, 0)
    const next = nextCronRun(weekly, from)!
    expect(previousCronRun(weekly, new Date(next))).toBe(next)
  })
})

describe('cronSummary', () => {
  const of = (expression: string) => cronSummary(spec(expression))

  it('describes the shapes a person actually writes', () => {
    expect(of('*/15 * * * *')).toEqual({ kind: 'everyMinutes', minutes: 15 })
    expect(of('* * * * *')).toEqual({ kind: 'everyMinutes', minutes: 1 })
    expect(of('5 * * * *')).toEqual({ kind: 'hourly', minute: 5 })
    expect(of('0 3 * * *')).toEqual({ kind: 'daily', hour: 3, minute: 0 })
    expect(of('15 4 * * sun')).toEqual({ kind: 'weekly', days: [0], hour: 4, minute: 15 })
    expect(of('0 9 * * mon-fri')).toEqual({ kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 })
    expect(of('0 0 1 * *')).toEqual({ kind: 'monthly', day: 1, hour: 0, minute: 0 })
  })

  it('falls back to custom rather than approximating, so the preview cannot lie', () => {
    expect(of('0 3 1,15 * *')).toEqual({ kind: 'custom' })
    expect(of('0 3 * jan mon')).toEqual({ kind: 'custom' })
    // A step that does not reach the end of the field is not "every n minutes".
    expect(of('0-58 * * * *')).toEqual({ kind: 'custom' })
  })
})

describe('cronProblem', () => {
  it('answers null for a valid expression and the sentence for an invalid one', () => {
    expect(cronProblem('0 3 * * *')).toBeNull()
    expect(cronProblem('0 3 * * * *')).toMatch(/5 fields/)
  })
})

describe('cronClock', () => {
  it('zero-pads to a 24-hour clock', () => {
    expect(cronClock(3, 0)).toBe('03:00')
    expect(cronClock(23, 59)).toBe('23:59')
  })
})

/**
 * Daylight saving, pinned to a zone that has it.
 *
 * The comment in `src/shared/cron.ts` claimed the spring-forward hour "runs at the instant the clock
 * jumps past it" — and it never did. Measured under `TZ=Europe/Berlin`, the occurrence is **skipped
 * for that day**, which is what Vixie cron does and what the comment now says.
 *
 * A test rather than a comment because that is exactly how the claim drifted: prose with nothing
 * holding it. `TZ` is set per-case, because the module reads the host's zone on purpose.
 */
describe('daylight saving', () => {
  // 2026: Berlin springs forward on 29 March (02:00 -> 03:00) and falls back on 25 October.
  const spring = '30 2 * * *'

  /**
   * `process.env.TZ` is set here rather than left to the machine: a CI box in UTC has no DST at all,
   * so every one of these assertions would fail there while passing on a developer's laptop in
   * Europe. The module reads the host zone on purpose, so the test has to say which zone it means.
   *
   * Node re-reads `TZ` for new `Date` objects on Linux; `vi.resetModules()` is not enough because the
   * parser holds no cached zone.
   */
  const original = process.env.TZ
  afterEach(() => {
    if (original === undefined)
      delete process.env.TZ
    else
      process.env.TZ = original
  })

  it('skips a local time that does not exist, rather than inventing an instant', () => {
    process.env.TZ = 'Europe/Berlin'
    const parsed = parseCron(spring)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok)
      return
    // From the evening before, and from inside the transition day: both answer the NEXT day.
    for (const from of [new Date(2026, 2, 28, 23, 0), new Date(2026, 2, 29, 0, 0), new Date(2026, 2, 29, 1, 0)]) {
      const next = nextCronRun(parsed.spec, from)
      expect(next).not.toBeNull()
      expect(new Date(next!).getDate(), 'the occurrence is skipped, so this is the 30th').toBe(30)
      expect(new Date(next!).getHours()).toBe(2)
      expect(new Date(next!).getMinutes()).toBe(30)
    }
    // And no wall-clock minute of the transition day reports it as due: 02:30 never happens, and
    // 03:00 is a different time.
    for (const [hour, minute] of [[1, 59], [2, 0], [3, 0], [3, 30]] as const)
      expect(cronDueAt(parsed.spec, new Date(2026, 2, 29, hour, minute)), `${hour}:${minute} must not be due`).toBe(false)
  })

  it('runs on the first of the two autumn occurrences', () => {
    process.env.TZ = 'Europe/Berlin'
    const parsed = parseCron(spring)
    if (!parsed.ok)
      throw new Error('parse failed')
    const next = nextCronRun(parsed.spec, new Date(2026, 9, 24, 12, 0))
    expect(next).not.toBeNull()
    const at = new Date(next!)
    expect(at.getDate(), 'the 25th, not a day later').toBe(25)
    expect(at.getHours()).toBe(2)
    expect(at.getMinutes()).toBe(30)
    // The FIRST 02:30 is at +02:00 (CEST); the second, an hour of real time later, is +01:00 (CET).
    expect(at.getTimezoneOffset(), 'the first occurrence is the summer offset').toBe(-120)
  })
})

/**
 * Vixie's OR rule turns on whether a day field **begins with `*`**, not on whether it equals it.
 *
 * A step over the whole range (`0-59/2`, written with a leading star) is a wildcard for the rule even though it selects half the
 * days. Reading it as "restricted" made a star-step day field paired with a weekday mean *an odd-day weekday*, which is a schedule
 * nobody writes: measured due on Mon 5 Jan 2026 and not on Mon 12 Jan.
 */
describe('a day field that begins with a star', () => {
  const day = (spec: Parameters<typeof nextCronRun>[0], month: number, date: number): boolean =>
    cronDueAt(spec, new Date(2026, month, date, 0, 0))

  it('treats `*/2` as a wildcard, so the weekday is the only restriction', () => {
    const parsed = parseCron('0 0 */2 * 1')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok)
      return
    expect(parsed.spec.domRestricted).toBe(false)
    expect(parsed.spec.dowRestricted).toBe(true)
    // Every Monday, whatever the date's parity: 5 Jan is odd, 12 Jan is even.
    expect(day(parsed.spec, 0, 5), 'Mon 5 Jan').toBe(true)
    expect(day(parsed.spec, 0, 12), 'Mon 12 Jan').toBe(true)
    expect(day(parsed.spec, 0, 6), 'Tue 6 Jan').toBe(false)
  })

  it('still treats a range-with-step as restricted, because it does not begin with a star', () => {
    const parsed = parseCron('0 0 1-31/2 * 1')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok)
      return
    expect(parsed.spec.domRestricted).toBe(true)
    // OR: an odd day *or* a Monday — so Sun 1 Feb (the 1st) is due, and Tue 6 Jan is not.
    expect(day(parsed.spec, 0, 5), 'Mon 5 Jan').toBe(true)
    expect(day(parsed.spec, 1, 1), 'Sun 1 Feb, the 1st').toBe(true)
    expect(day(parsed.spec, 0, 6), 'Tue 6 Jan').toBe(false)
  })
})
