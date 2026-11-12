import type { ScheduledEntry } from '#src/services/scheduler'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  return { id: 'nightly', kind: 'job', schedule: '0 3 * * *', enabled: true, ...overrides }
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

  it('runs every job on the workspace, and only the jobs', async () => {
    const harness = makeScheduler([
      job({ id: 'a' }),
      job({ id: 'b' }),
      // A service is supervised continuously; a schedule on it is refused by the config, and this one
      // has none, so nothing about it may run.
      { id: 'web', kind: 'service', enabled: true },
    ])
    harness.scheduler.tick(local(2026, 3, 10, 3, 0))
    expect(harness.runs.map(run => run.id).sort()).toEqual(['a', 'b'])
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
