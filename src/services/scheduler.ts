import { logger } from '#src/helpers/logger'
import { cronDueAt, nextCronRun, parseCron, previousCronRun } from '#src/shared/cron'

/**
 * When a workspace's jobs run.
 *
 * **Beside the backup schedule, on the panel's own clock.** `BackupService.tick()` and this service
 * are driven by the same 1 Hz panel tick, for the same reasons: no second timer, no per-tick syscall,
 * and a pass that cannot stack up behind itself. `tick()` is therefore cheap enough to call every
 * second — it reads an in-memory map and, at most, one `Date` per job.
 *
 * **The clock is the host's local timezone**, exactly as `src/shared/cron.ts` documents. A home
 * server's owner thinks in that machine's time.
 *
 * Three rules shape the behaviour, and each exists for a schedule a person would otherwise not trust:
 *
 *  - **One run per occurrence, decided from the occurrence and not the tick.** `tick()` asks cron for
 *    the last scheduled minute at or before now (`previousCronRun`), and remembers which occurrence it
 *    last started. A tick that lands a few hundred ms late, or a panel whose loop was busy for ten
 *    seconds, still starts exactly one run for that minute — **never two**. This is why the second and
 *    later ticks of the same minute do nothing.
 *
 *    It is *not* a promise that nothing is skipped: a loop stalled across several occurrences runs
 *    the one due when it resumes and drops the ones between (measured: 10:00 then 10:17 on
 *    a five-minute schedule runs 10:00 and 10:15, not 10:05 or 10:10). Replaying them would turn one stall
 *    into a burst, which is worse than a documented gap.
 *  - **An overlapping run is skipped, and said so.** A job still running when its next occurrence
 *    arrives is not queued behind itself: two copies of a backup writing the same files is the
 *    failure this avoids. The skip is logged on the entry and recorded as an `overlap` in its
 *    history, so it is a fact a person can find — not a silence.
 *  - **A missed occurrence runs once, at boot.** A panel that was down across 03:00 must not silently
 *    lose the night's job, and must not replay a week of them either. The first tick after boot starts
 *    at most **one** run per job — for the most recent occurrence — and the durable record is what
 *    decides whether it is owed: the newest `job-run` event in the workspace history (which survives a
 *    restart) is compared against that occurrence. A panel restarted in a loop therefore does not
 *    replay an occurrence it already ran.
 *
 * Nothing here persists a schedule of its own: the config is the list of jobs, and the history event
 * each run writes is both the durable record and what the view reports `lastRunAt` from.
 */

/** What the scheduler needs from the supervisor, and nothing more. */
export interface JobSchedulerOptions {
  /** The workspace's entries as the config resolves them, in the order the config lists them. */
  servers: () => readonly ScheduledEntry[]
  /** Whether this job has a run in flight right now. */
  isRunning: (id: string) => boolean
  /** Starts one run and resolves when it ends. The supervisor owns the process and records it. */
  run: (id: string, occurrence: number) => Promise<{ exitCode: number | null }>
  /** The run was skipped because the previous one is still going: logged and recorded by the owner. */
  noteOverlap: (id: string, occurrence: number) => void
  /**
   * When this job last ran, from the workspace's **durable** history — the boot catch-up's only input.
   *
   * The in-memory clock cannot answer this across a panel restart, and that is exactly the case the
   * catch-up rule is about. `null` when the job has never run.
   */
  lastRunAt: (id: string) => number | null
  /** A view changed (a run started or finished), so the panel should publish a frame. */
  onStateChange: () => void
}

/** The slice of one configured entry the scheduler reads. */
export interface ScheduledEntry {
  id: string
  kind?: string
  schedule?: string
  enabled: boolean
}

/** One job's clock: which occurrence was last started, and when its last run ended. */
interface JobClock {
  /** The occurrence (epoch ms, floored to the minute) this job was last started for. */
  lastStartedFor: number | null
  /** The last run's end, and its exit code — what the view shows as `lastRunAt`/`lastExitCode`. */
  lastRunAt: number | null
  lastExitCode: number | null
  /** Set when a run was skipped for being already in flight. */
  lastOverlapAt: number | null
  /** Why this job's expression is unusable, so a standing typo is logged once, not every tick. */
  reportedProblem: string | null
}

export class JobScheduler {
  private readonly clocks = new Map<string, JobClock>()
  private disposed = false

  constructor(private readonly options: JobSchedulerOptions) {}

  /** One job's clock, for the view and for a test. */
  clock(id: string): Readonly<JobClock> | undefined {
    return this.clocks.get(id)
  }

  /**
   * One pass over every job, cheap enough for the panel's 1 Hz tick.
   *
   * Reads only memory, the already-resolved config and — once per job per boot — the history store.
   * No filesystem call, no `execFileSync`, nothing on the frame path (`AGENTS.md`, "no per-frame
   * syscalls").
   */
  tick(now = Date.now()): void {
    if (this.disposed)
      return
    const jobs = this.options.servers().filter(server => server.kind === 'job')
    // Drop the clocks of jobs that no longer exist or stopped being jobs, so a renamed or removed
    // entry cannot inherit another's occurrence and skip its first run.
    const known = new Set(jobs.map(job => job.id))
    for (const id of [...this.clocks.keys()]) {
      if (!known.has(id))
        this.clocks.delete(id)
    }

    for (const job of jobs) {
      if (!job.enabled)
        continue
      this.consider(job.id, job.schedule, now)
    }
  }

  private consider(id: string, schedule: string | undefined, now: number): void {
    const clock = this.clockFor(id)
    if (schedule === undefined) {
      this.reportOnce(clock, id, 'a job has no `schedule`')
      return
    }
    const parsed = parseCron(schedule)
    if (!parsed.ok) {
      this.reportOnce(clock, id, parsed.problem)
      return
    }
    clock.reportedProblem = null

    /**
     * The occurrence that is due now: the scheduled minute at or before `now`. Deriving it from the
     * clock rather than from the tick interval is what makes "exactly once" true at any tick rate.
     */
    const due = previousCronRun(parsed.spec, new Date(now))
    if (due === null) {
      // The expression names a day that cannot occur (`0 0 31 4 *`).
      this.reportOnce(clock, id, `the schedule never comes due (${schedule})`)
      return
    }

    // Already started for this occurrence: every later tick of the same minute does nothing.
    if (clock.lastStartedFor !== null && due <= clock.lastStartedFor)
      return

    /**
     * This boot's first sight of this job. Two cases, and the durable record separates them:
     *  - the newest `job-run` event already covers this occurrence (the panel was up, or restarted
     *    inside the minute it ran) → nothing is owed;
     *  - it does not → the panel was down across it, so exactly one run is owed, now.
     *
     * Either way the occurrence is marked started, so the following ticks are silent and a restart
     * loop cannot replay it.
     */
    if (clock.lastStartedFor === null) {
      const lastRun = clock.lastRunAt ?? this.options.lastRunAt(id)
      clock.lastRunAt = lastRun
      if (lastRun !== null && lastRun >= due) {
        clock.lastStartedFor = due
        return
      }
    }

    this.start(id, clock, due, now)
  }

  private start(id: string, clock: JobClock, occurrence: number, now: number): void {
    // A run already in flight: skipped, logged and recorded — never queued behind itself.
    if (this.options.isRunning(id)) {
      clock.lastStartedFor = occurrence
      clock.lastOverlapAt = now
      this.options.noteOverlap(id, occurrence)
      this.options.onStateChange()
      logger.warn(`the scheduled run of job "${id}" was skipped: the previous run is still going`)
      return
    }

    clock.lastStartedFor = occurrence
    // Not awaited: a job runs for as long as it runs, and the tick must return. The outcome is
    // recorded by the supervisor; the clock is updated here so a second occurrence cannot start while
    // this one is marked done but still executing.
    void this.options
      .run(id, occurrence)
      .then((outcome) => {
        clock.lastRunAt = Date.now()
        clock.lastExitCode = outcome.exitCode
        this.options.onStateChange()
      })
      .catch((error: unknown) => {
        // A run that rejects would be an unhandled rejection, which ends Node 24. Report it.
        logger.error(`the scheduled run of job "${id}" failed unexpectedly`, error)
      })
  }

  /**
   * When this job next runs, from its own expression and the host clock.
   *
   * `null` for a job that cannot run (no schedule, a broken one, a day that never occurs). Called when
   * the view is built, so it stays cheap: one cron search over a few hundred steps and no I/O.
   */
  nextRunAt(schedule: string | undefined, from = Date.now()): number | null {
    if (schedule === undefined)
      return null
    const parsed = parseCron(schedule)
    return parsed.ok ? nextCronRun(parsed.spec, new Date(from)) : null
  }

  /** Whether a job's expression is due at this minute — the pure question, for a test. */
  dueNow(schedule: string, now = Date.now()): boolean {
    const parsed = parseCron(schedule)
    return parsed.ok && cronDueAt(parsed.spec, new Date(now))
  }

  dispose(): void {
    this.disposed = true
    this.clocks.clear()
  }

  private clockFor(id: string): JobClock {
    const existing = this.clocks.get(id)
    if (existing !== undefined)
      return existing
    const clock: JobClock = { lastStartedFor: null, lastRunAt: null, lastExitCode: null, lastOverlapAt: null, reportedProblem: null }
    this.clocks.set(id, clock)
    return clock
  }

  /** A standing problem is logged when it appears and when it changes, not on every tick. */
  private reportOnce(clock: JobClock, id: string, problem: string): void {
    if (clock.reportedProblem === problem)
      return
    clock.reportedProblem = problem
    logger.warn(`job "${id}": ${problem}`)
  }
}
