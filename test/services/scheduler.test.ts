import type { ScheduledEntry } from '#src/services/scheduler'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { logger } from '#src/helpers/logger'
import { JobScheduler } from '#src/services/scheduler'

/**
 * When a job runs, tested as **timing** and nothing else.
 *
 * The scheduler's whole contract is "one run per occurrence, skip an overlap, catch up once at boot",
 * and every one of those is decidable from a clock and a set of entries. The supervisor owns the
 * process, the log and the history event, so no child is spawned here — which is what makes the
 * boundary cases (a tick two hundred milliseconds late, a panel that was down for a day, two jobs on
 * one expression) testable at all.
 *
 * Every date is a **local** `new Date(...)`, the same wall clock the parser reads, so the suite asserts
 * the same behaviour in any timezone.
 */

function local(year: number, month: number, day: number, hour: number, minute: number, second = 0): number {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime()
}

interface Harness {
  scheduler: JobScheduler
  runs: Array<{ id: string, occurrence: number }>
  overlaps: Array<{ id: string, occurrence: number }>
  stateChanges: () => number
  /** Set by a test to make `isRunning` answer true for an id. */
  running: Set<string>
  /** Set by a test to give a job a previous run in the durable history. */
  lastRuns: Map<string, number>
  /** Resolve the promise each run returns, so an overlap can be created deterministically. */
  release: Map<string, (exitCode: number | null) => void>
  holdRuns: boolean
}

function makeScheduler(entries: ScheduledEntry[]): Harness {
  const runs: Array<{ id: string, occurrence: number }> = []
  const overlaps: Array<{ id: string, occurrence: number }> = []
  const running = new Set<string>()
  const lastRuns = new Map<string, number>()
  const release = new Map<string, (exitCode: number | null) => void>()
  let stateChanges = 0
  const harness: Harness = {
    scheduler: undefined as unknown as JobScheduler,
    runs,
    overlaps,
    stateChanges: () => stateChanges,
    running,
    lastRuns,
    release,
    holdRuns: false,
  }

  harness.scheduler = new JobScheduler({
    servers: () => entries,
    isRunning: id => running.has(id),
    run: (id, occurrence) => {
      runs.push({ id, occurrence })
      running.add(id)
      const finish = (): void => {
        running.delete(id)
      }
      if (!harness.holdRuns) {
        finish()
        return Promise.resolve({ exitCode: 0 })
      }
      return new Promise((resolve) => {
        release.set(id, (exitCode) => {
          finish()
          resolve({ exitCode })
        })
      })
    },
    noteOverlap: (id, occurrence) => {
      overlaps.push({ id, occurrence })
    },
    lastRunAt: id => lastRuns.get(id) ?? null,
    onStateChange: () => {
      stateChanges += 1
    },
  })
  return harness
}

function job(overrides: Partial<ScheduledEntry> = {}): ScheduledEntry {
  return { id: 'nightly', schedule: '0 3 * * *', enabled: true, ...overrides }
}

/**
 * Every `logger.warn` line, collected through the logger the scheduler actually calls.
 *
 * A standing problem is reported through `reportOnce`, whose whole contract is "once, not every tick";
 * observing the real call is the only way to count them.
 */
function warnSpy(): string[] {
  const lines: string[] = []
  vi.spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  return lines
}

afterEach(() => {
  vi.useRealTimers()
})

describe('one run per occurrence', () => {
  it('starts the run at its minute, and not again on a later tick of the same minute', async () => {
    const harness = makeScheduler([job()])
    // 03:00:00 — the occurrence itself.
    harness.scheduler.tick(local(2026, 3, 10, 3, 0, 0))
    expect(harness.runs).toHaveLength(1)
    expect(harness.runs[0]!.occurrence).toBe(local(2026, 3, 10, 3, 0, 0))

    // The panel tick is 1 Hz: every later tick inside the minute must do nothing.
    for (const second of [1, 2, 30, 59])
      harness.scheduler.tick(local(2026, 3, 10, 3, 0, second))
    expect(harness.runs).toHaveLength(1)
  })

  it('still starts exactly one run when the tick is late, or the loop was busy', async () => {
    const harness = makeScheduler([job()])
    // A panel that woke up at 03:07 having missed the whole minute: the occurrence is still 03:00,
    // and it is still owed — once.
    harness.scheduler.tick(local(2026, 3, 10, 3, 7))
    expect(harness.runs).toHaveLength(1)
    expect(harness.runs[0]!.occurrence).toBe(local(2026, 3, 10, 3, 0, 0))
  })

  it('does nothing before the next occurrence once the previous one is covered', async () => {
    const harness = makeScheduler([job()])
    // The durable history says yesterday's run happened, so booting at 02:59 owes nothing.
    harness.lastRuns.set('nightly', local(2026, 3, 9, 3, 0, 5))
    harness.scheduler.tick(local(2026, 3, 10, 2, 59))
    expect(harness.runs).toHaveLength(0)
    // 03:00 then comes due normally.
    harness.scheduler.tick(local(2026, 3, 10, 3, 0))
    expect(harness.runs).toHaveLength(1)
  })

  it('runs once at each occurrence, not on the ticks between them', async () => {
    const harness = makeScheduler([job({ schedule: '*/15 * * * *' })])
    harness.scheduler.tick(local(2026, 3, 10, 9, 0))
    harness.scheduler.tick(local(2026, 3, 10, 9, 1))
    harness.scheduler.tick(local(2026, 3, 10, 9, 14))
    expect(harness.runs).toHaveLength(1)
    harness.scheduler.tick(local(2026, 3, 10, 9, 15))
    expect(harness.runs).toHaveLength(2)
    expect(harness.runs[1]!.occurrence).toBe(local(2026, 3, 10, 9, 15))
  })

  it('runs every job it is given', async () => {
    const harness = makeScheduler([job({ id: 'a' }), job({ id: 'b' })])
    harness.scheduler.tick(local(2026, 3, 10, 3, 0))
    expect(harness.runs.map(run => run.id).sort()).toEqual(['a', 'b'])
  })

  /**
   * An entry with **no** schedule never runs.
   *
   * The old shape had to filter services out of a mixed list, because a server could appear beside a
   * job. A job now lives in its own file, where `schedule` is required — so the remaining case is the
   * one this pins: an entry handed to the scheduler without a schedule is silent, not run at every
   * tick.
   */
  it('never runs an entry that carries no schedule', async () => {
    const harness = makeScheduler([{ id: 'schedless', enabled: true } as never])
    harness.scheduler.tick(local(2026, 3, 10, 3, 0))
    expect(harness.runs).toEqual([])
  })

  it('skips a disabled job, and reports nothing for a broken expression', async () => {
    const harness = makeScheduler([job({ enabled: false }), job({ id: 'broken', schedule: '0 3 * * nope' })])
    harness.scheduler.tick(local(2026, 3, 10, 3, 0))
    expect(harness.runs).toHaveLength(0)
  })

  it('drops the clock of an entry that stopped being a job, so a re-add starts fresh', async () => {
    const entries: ScheduledEntry[] = [job()]
    const harness = makeScheduler(entries)
    harness.scheduler.tick(local(2026, 3, 10, 3, 0))
    expect(harness.runs).toHaveLength(1)

    // The entry is removed and re-added in the same minute: a clock kept from the old one would skip
    // the new entry's first run for an occurrence it never had.
    entries.splice(0, 1)
    harness.scheduler.tick(local(2026, 3, 10, 3, 0, 10))
    expect(harness.scheduler.clock('nightly')).toBeUndefined()
  })
})

describe('an overlapping run is skipped, and recorded', () => {
  it('does not queue a second run behind one still going', async () => {
    const harness = makeScheduler([job({ schedule: '*/5 * * * *' })])
    harness.holdRuns = true
    harness.scheduler.tick(local(2026, 3, 10, 9, 0))
    expect(harness.runs).toHaveLength(1)

    // Five minutes later the first run is still going: the occurrence is skipped, not stacked.
    harness.scheduler.tick(local(2026, 3, 10, 9, 5))
    expect(harness.runs).toHaveLength(1)
    expect(harness.overlaps).toEqual([{ id: 'nightly', occurrence: local(2026, 3, 10, 9, 5) }])
    expect(harness.scheduler.clock('nightly')?.lastOverlapAt).toBe(local(2026, 3, 10, 9, 5))

    // The run ends, and the next occurrence runs normally.
    harness.release.get('nightly')?.(0)
    await Promise.resolve()
    harness.scheduler.tick(local(2026, 3, 10, 9, 10))
    expect(harness.runs).toHaveLength(2)
  })

  it('records the skip once per occurrence, not on every tick of that minute', async () => {
    const harness = makeScheduler([job({ schedule: '*/5 * * * *' })])
    harness.holdRuns = true
    // 09:00 starts and is still going when 09:05 arrives.
    harness.scheduler.tick(local(2026, 3, 10, 9, 0))
    harness.scheduler.tick(local(2026, 3, 10, 9, 5))
    expect(harness.overlaps).toHaveLength(1)
    // The rest of that minute is silent, so a 1 Hz tick cannot write the skip sixty times.
    harness.scheduler.tick(local(2026, 3, 10, 9, 5, 1))
    harness.scheduler.tick(local(2026, 3, 10, 9, 5, 30))
    expect(harness.overlaps).toHaveLength(1)
  })
})

describe('a missed occurrence runs once, at boot', () => {
  it('runs an occurrence the panel was down for', async () => {
    // No run in the durable history: the panel never ran this job, so last night's 03:00 is owed.
    const harness = makeScheduler([job()])
    harness.scheduler.tick(local(2026, 3, 10, 11, 0))
    expect(harness.runs).toHaveLength(1)
    expect(harness.runs[0]!.occurrence).toBe(local(2026, 3, 10, 3, 0, 0))
  })

  /**
   * A job declared **while the panel is up** owes nothing, and must not fire on the spot.
   *
   * The catch-up rule above is about a panel that was down across an occurrence. A job that did not
   * exist yet has no such occurrence, but it took the same path: `lastRun === null` fell through the
   * guard and started a run for a stale occurrence. Measured on a live panel: declaring
   * `0 3 * * *` at 09:44:37 ran it at 09:44:37 with `nextRunAt` already tomorrow, and the same for
   * `0 0 1 1 *` (ran for 1 January, ten months earlier) and `05 * * * *` (an hour and a half late).
   * Declaring a nightly backup must mean "waits until 03:00", not "runs now, then again at 03:00".
   */
  it('does not run a job that was declared after the panel started', async () => {
    const entries: ScheduledEntry[] = []
    const harness = makeScheduler(entries)
    // The panel's first tick, with no jobs at all: this is the boot.
    harness.scheduler.tick(local(2026, 3, 10, 9, 44))
    expect(harness.runs).toHaveLength(0)

    // A person adds `0 3 * * *` while the panel is running, long after 03:00 went by.
    entries.push(job({ id: 'brand-new' }))
    harness.scheduler.tick(local(2026, 3, 10, 9, 44, 1))
    expect(harness.runs, 'a job born mid-morning must not make up a 03:00 it never saw').toHaveLength(0)

    // And the following ticks stay quiet, rather than firing one tick later.
    harness.scheduler.tick(local(2026, 3, 10, 9, 45))
    harness.scheduler.tick(local(2026, 3, 10, 11, 0))
    expect(harness.runs).toHaveLength(0)

    // The occurrence it was declared for is still owed tomorrow, so 03:00 does run it.
    harness.scheduler.tick(local(2026, 3, 11, 3, 0))
    expect(harness.runs).toHaveLength(1)
    expect(harness.runs[0]!.occurrence).toBe(local(2026, 3, 11, 3, 0, 0))
  })

  /**
   * A job present at the panel's **first** tick still catches up — the rule above must not have
   * turned the feature off.
   */
  it('still catches up a job that was already there when the panel started', async () => {
    const harness = makeScheduler([job()])
    harness.scheduler.tick(local(2026, 3, 10, 11, 0))
    expect(harness.runs).toHaveLength(1)
    expect(harness.runs[0]!.occurrence).toBe(local(2026, 3, 10, 3, 0, 0))
  })

  /**
   * An un-runnable schedule is reported **once**, not once per tick.
   *
   * `clock.reportedProblem` was cleared straight after parsing succeeded — before the "no occurrence"
   * branch that reports — so the suppression in `reportOnce` never engaged for the one case it exists
   * for. Measured on a live panel: 250 identical WARN lines, then 270 twenty seconds later, i.e. one
   * per second per job — 86 400 lines a day, which rotates every real event out of `home-hosted logs`.
   */
  it('reports an un-runnable schedule once, not on every tick', async () => {
    const warns = warnSpy()
    const harness = makeScheduler([job({ schedule: '0 0 31 4 *' })])
    for (let second = 0; second < 60; second++)
      harness.scheduler.tick(local(2026, 3, 10, 11, 0, second))

    expect(harness.runs).toHaveLength(0)
    expect(warns.filter(line => line.includes('31 April')), 'one line for a standing problem').toHaveLength(1)
  })

  it('reports a schedule that is fixed and then broken again', async () => {
    const warns = warnSpy()
    const entries: ScheduledEntry[] = [job({ schedule: '0 0 31 4 *' })]
    const harness = makeScheduler(entries)
    harness.scheduler.tick(local(2026, 3, 10, 11, 0))
    expect(warns.filter(line => line.includes('31 April'))).toHaveLength(1)

    // Fixed: a real expression, so the standing complaint clears.
    entries[0] = job({ schedule: '0 3 * * *' })
    harness.scheduler.tick(local(2026, 3, 10, 11, 0, 1))

    // Broken again: it is news again, so it must be reported again.
    entries[0] = job({ schedule: '0 0 31 4 *' })
    harness.scheduler.tick(local(2026, 3, 10, 11, 0, 2))
    expect(warns.filter(line => line.includes('31 April')), 'a new problem is worth saying').toHaveLength(2)
  })

  it('does not run an occurrence the durable history already covers', async () => {
    const harness = makeScheduler([job()])
    // The panel was up and ran it at 03:00, then restarted at 03:30.
    harness.lastRuns.set('nightly', local(2026, 3, 10, 3, 0, 20))
    harness.scheduler.tick(local(2026, 3, 10, 3, 30))
    expect(harness.runs).toHaveLength(0)
    // And the clock is seeded, so the rest of the day is quiet.
    harness.scheduler.tick(local(2026, 3, 10, 3, 31))
    expect(harness.runs).toHaveLength(0)
  })

  it('replays one occurrence, not one per missed day', async () => {
    const harness = makeScheduler([job()])
    // Down for a week: exactly one catch-up run, for the most recent occurrence.
    harness.lastRuns.set('nightly', local(2026, 3, 3, 3, 0, 5))
    harness.scheduler.tick(local(2026, 3, 10, 11, 0))
    expect(harness.runs).toHaveLength(1)
    expect(harness.runs[0]!.occurrence).toBe(local(2026, 3, 10, 3, 0, 0))
    // And a further tick is silent, so a restart loop cannot replay it.
    harness.scheduler.tick(local(2026, 3, 10, 11, 0, 1))
    expect(harness.runs).toHaveLength(1)
  })

  it('does not treat a run that finished after the occurrence as still owed', async () => {
    const harness = makeScheduler([job()])
    // Ran at 03:00 and took 40 minutes: the record is the *start* of that event, and it covers 03:00.
    harness.lastRuns.set('nightly', local(2026, 3, 10, 3, 0, 2))
    harness.scheduler.tick(local(2026, 3, 10, 3, 40))
    expect(harness.runs).toHaveLength(0)
  })
})

describe('nextRunAt', () => {
  it('reports the next occurrence from the host clock', () => {
    const harness = makeScheduler([job()])
    expect(harness.scheduler.nextRunAt('0 3 * * *', local(2026, 3, 10, 2, 0))).toBe(local(2026, 3, 10, 3, 0, 0))
    // Past it, the answer is tomorrow's.
    expect(harness.scheduler.nextRunAt('0 3 * * *', local(2026, 3, 10, 3, 1))).toBe(local(2026, 3, 11, 3, 0, 0))
  })

  it('answers null for no schedule, a broken one, and a day that never occurs', () => {
    const harness = makeScheduler([])
    expect(harness.scheduler.nextRunAt(undefined)).toBeNull()
    expect(harness.scheduler.nextRunAt('0 3 * * nope')).toBeNull()
    expect(harness.scheduler.nextRunAt('0 0 31 4 *')).toBeNull()
  })
})

describe('dueNow', () => {
  it('answers the pure question, with no ticking involved', () => {
    const harness = makeScheduler([])
    expect(harness.scheduler.dueNow('0 3 * * *', local(2026, 3, 10, 3, 0))).toBe(true)
    expect(harness.scheduler.dueNow('0 3 * * *', local(2026, 3, 10, 3, 1))).toBe(false)
  })
})

describe('dispose', () => {
  it('stops ticking, so a torn-down panel starts nothing', () => {
    const harness = makeScheduler([job()])
    harness.scheduler.dispose()
    harness.scheduler.tick(local(2026, 3, 10, 3, 0))
    expect(harness.runs).toHaveLength(0)
  })
})

/**
 * A job runs **once** for a wall-clock time that happens twice.
 *
 * This is the regression the review found, and it was invisible to the cron unit tests because they
 * only asked `previousCronRun` from *before* the fold. Driving the real scheduler second by second
 * through the change is what shows it: `started` was three runs for `30 1 * * *` in
 * `America/New_York`, two of them at 01:30, because the scheduler saw the two identical wall readings
 * as two occurrences.
 *
 * The root cause was `setSeconds(0, 0)` re-resolving an ambiguous local time to the *earlier* offset,
 * which walked the search an hour backwards, so it answered yesterday's occurrence and the
 * `due <= lastStartedFor` guard then fired again. The fix is in `src/shared/cron.ts`.
 *
 * `TZ` is set here, not inherited: this suite runs in whatever zone the machine has, and in UTC there
 * is no fold at all, so the test would pass while proving nothing.
 */
describe('a repeated wall-clock time', () => {
  const original = process.env.TZ
  afterEach(() => {
    if (original === undefined)
      delete process.env.TZ
    else
      process.env.TZ = original
  })

  /**
   * A panel that has been up, so the previous occurrence is already in its durable history.
   *
   * The seed matters: a panel whose first ever tick lands before an occurrence legitimately owes
   * **one** catch-up run for it (that is the boot rule, tested above). Seeding the history is what
   * makes this test about the *second* run for a repeated wall time — the regression — rather than
   * about the catch-up.
   */
  it.each([
    // 2026-11-01: New York goes 02:00 EDT -> 01:00 EST, so 01:30 happens twice. The first is 05:30Z.
    ['America/New_York', '30 1 * * *', Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 10, 1, 5, 31), Date.UTC(2026, 10, 1, 8, 0)],
    // 2026-10-25: Berlin goes 03:00 CEST -> 02:00 CET, so 02:00 happens twice. The first is 00:00Z.
    // Berlin's FIRST 02:00 is 00:00Z (CEST); the repeated one is 01:00Z (CET).
    ['Europe/Berlin', '0 2 * * *', Date.UTC(2026, 9, 25, 0, 0), Date.UTC(2026, 9, 25, 0, 1), Date.UTC(2026, 9, 25, 3, 0)],
    /**
     * `Antarctica/Troll` is the one **two-hour** fold in the tz database: 2026-10-25 01:00 -> 03:00
     * UTC, so 01:30 happens twice, two hours apart. A fixed 60/30-minute probe missed it, which is
     * why the search now walks a bounded window instead of assuming an offset.
     */
    ['Antarctica/Troll', '30 1 * * *', Date.UTC(2026, 9, 25, 1, 30), Date.UTC(2026, 9, 25, 1, 31), Date.UTC(2026, 9, 25, 4, 0)],
  ])('does not run again for the repeated hour in %s', async (zone, expression, firstRunAt, from, to) => {
    process.env.TZ = zone
    const harness = makeScheduler([{ id: 'nightly', schedule: expression, enabled: true }])
    harness.lastRuns.set('nightly', firstRunAt)

    // Every tick the panel would make, second by second, through the rest of the fold.
    for (let clock = from; clock <= to; clock += 1000)
      await harness.scheduler.tick(clock)

    expect(harness.runs, 'the same wall-clock time is ONE occurrence').toHaveLength(0)
    harness.scheduler.dispose()
  })

  it('still runs the next night, so the dedup did not swallow the schedule', async () => {
    process.env.TZ = 'America/New_York'
    const harness = makeScheduler([{ id: 'nightly', schedule: '30 1 * * *', enabled: true }])
    harness.lastRuns.set('nightly', Date.UTC(2026, 10, 1, 5, 30))

    // The rest of the fold night, then the whole of the following night.
    for (let clock = Date.UTC(2026, 10, 1, 5, 31); clock <= Date.UTC(2026, 10, 1, 7, 30); clock += 60_000)
      await harness.scheduler.tick(clock)
    for (let clock = Date.UTC(2026, 10, 2, 4, 30); clock <= Date.UTC(2026, 10, 2, 7, 30); clock += 60_000)
      await harness.scheduler.tick(clock)

    expect(harness.runs, 'the following night still runs').toHaveLength(1)
    harness.scheduler.dispose()
  })
})

/**
 * A panel restarted **during** a run does not start a second copy.
 *
 * The completion event alone left the hole: a run in flight had written nothing yet, so a panel that
 * restarted concluded the occurrence was missed and started another copy while the first was still
 * going — two copies writing the same files, which is the failure the overlap rule exists to prevent.
 *
 * The claim is now durable and written *before* the spawn, so the catch-up's only input sees the
 * occurrence as taken.
 */
describe('a restart during a run', () => {
  it('sees the occurrence as claimed, rather than missed', async () => {
    const harness = makeScheduler([job({ schedule: '0 3 * * *' })])
    const occurrence = local(2026, 5, 10, 3, 0, 0)
    // The durable record of the run that is still going: its `running` claim, written at the
    // occurrence. This is exactly what `history.lastEventAt(id, 'job-run')` answers after a restart.
    harness.lastRuns.set('nightly', occurrence)

    harness.scheduler.tick(occurrence + 30_000)

    expect(harness.runs, 'a run already on record must not be started again').toHaveLength(0)
    harness.scheduler.dispose()
  })

  it('still runs an occurrence that no record covers', async () => {
    const harness = makeScheduler([job({ schedule: '0 3 * * *' })])
    const occurrence = local(2026, 5, 10, 3, 0, 0)
    // The last run on record is from the previous day, so today's 03:00 is genuinely owed.
    harness.lastRuns.set('nightly', local(2026, 5, 9, 3, 0, 0))

    harness.scheduler.tick(occurrence + 30_000)

    expect(harness.runs, 'a missed occurrence still runs once').toHaveLength(1)
    harness.scheduler.dispose()
  })
})

/**
 * The tick cache is what keeps a minute of ticking to one scan per schedule, not sixty.
 *
 * The regression the review found: caching the due occurrence in a single slot meant two jobs on
 * different rare schedules overwrote each other, so neither ever hit and every tick paid a full scan —
 * six distinct schedules cost 14 s for sixty ticks instead of ~400 ms.
 *
 * The assertion is a **ratio against a single tick**, not a stopwatch, because that is exactly what the
 * cache promises: sixty ticks of one minute should cost about as much as one. A wall-clock bound passes
 * on fast hardware even after a 15× regression and rots as machines get quicker. Note the cost still
 * grows *linearly with the number of distinct schedules* — the first tick of a minute pays one scan
 * each — which is why the honest invariant is per-schedule, not "six costs the same as three".
 */
describe('the tick cache', () => {
  /** Ticks the panel would make in one minute, for `count` distinct never-due schedules. */
  function ticker(count: number) {
    const rare = Array.from({ length: count }, (_, index) => `${index} ${index} 31 4 *`)
    const harness = makeScheduler(rare.map((schedule, index) => job({ id: `j${index}`, schedule })))
    return { harness, start: local(2026, 5, 1, 12, 0, 0) }
  }

  it('costs one scan per schedule for a minute of ticks, not one per tick', async () => {
    const { harness, start } = ticker(6)
    // Warm the JIT, then measure the first tick of the minute on its own.
    await harness.scheduler.tick(start - 120_000)
    const singleBegan = Date.now()
    await harness.scheduler.tick(start)
    const single = Math.max(Date.now() - singleBegan, 1)

    const minuteBegan = Date.now()
    for (let second = 1; second < 60; second += 1)
      await harness.scheduler.tick(start + second * 1000)
    const rest = Date.now() - minuteBegan

    expect(harness.runs, 'none of these ever comes due').toHaveLength(0)
    // With the cache, the other 59 ticks are lookups; without it they are 59 more scans each, which is
    // roughly 59× the first. A factor of 10 separates the two with room for timer noise.
    expect(rest, `first tick ${single}ms, remaining 59 ticks ${rest}ms`).toBeLessThan(single * 10)
    harness.scheduler.dispose()
  })
})

describe('a rare but valid schedule', () => {
  it('stays silent for a leap day, and still warns for an impossible date', async () => {
    const leap = makeScheduler([job({ id: 'leap', schedule: '0 0 29 2 *' })])
    // A day nowhere near a leap day, ticked as the panel would.
    for (let second = 0; second < 60; second += 1)
      await leap.scheduler.tick(local(2026, 5, 1, 12, 0, 0) + second * 1000)
    expect(leap.scheduler.clock('leap')?.reportedProblem, 'a leap day is valid, not broken').toBeNull()
    expect(leap.runs).toHaveLength(0)
    leap.scheduler.dispose()

    const impossible = makeScheduler([job({ id: 'never', schedule: '0 0 31 4 *' })])
    await impossible.scheduler.tick(local(2026, 5, 1, 12, 0, 0))
    expect(impossible.scheduler.clock('never')?.reportedProblem, '31 April cannot occur').toContain('past year')
    impossible.scheduler.dispose()
  })
})
