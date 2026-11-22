import { logger } from '#src/helpers/logger'
import { cronDueAt, nextCronRun, parseCron, previousCronRun } from '#src/shared/cron'

/**
 * When a workspace's jobs run.
 *
 * Driven by the panel's own 1 Hz tick beside the backup schedule — no second timer, no per-tick
 * syscall — so `tick()` reads an in-memory map and at most one `Date` per job. The clock is the host's
 * local timezone.
 *
 * Three rules, each for a schedule a person would otherwise not trust:
 *
 * - **One run per occurrence, decided from the occurrence and not the tick**, so a late tick still
 *   starts exactly one run. A loop stalled across several occurrences runs the one due when it resumes
 *   and drops the ones between — replaying them would turn one stall into a burst.
 * - **An overlapping run is skipped and recorded as `overlap`**, not queued: two copies of a backup
 *   writing the same files is the failure this avoids.
 * - **A missed occurrence runs once, at boot**, for the most recent one only, decided by comparing the
 *   newest durable `job-run` event against it. A panel restarted in a loop does not replay.
 *
 * Nothing here persists a schedule: the config is the job list, and the history event each run writes is
 * both the durable record and what the view reports `lastRunAt` from.
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

/** The slice of one configured job the scheduler reads. */
export interface ScheduledEntry {
  id: string
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
  /** The due occurrence this job was last considered for — what `start` records against. */
  due: number | null
  /**
   * Whether this job was already in the config on the **first** tick this scheduler ran.
   *
   * The boot catch-up rule ("a panel that was down across 03:00 owes one run") is about a panel that
   * was down, and only a job that existed before the panel started can have been missed by it. A job
   * declared *while the panel is up* has no missed occurrence at all, and treating its first
   * appearance as a boot made creating a nightly backup run it immediately — measured: declaring
   * `0 3 * * *` at 09:44 fired it at 09:44:37, with `nextRunAt` already tomorrow.
   */
  seenAtBoot: boolean
}

export class JobScheduler {
  private readonly clocks = new Map<string, JobClock>()
  /**
   * This minute's due occurrence for each distinct expression — cleared when the minute changes.
   *
   * A map rather than one slot, because two jobs on different rare schedules is ordinary, and a single
   * slot made both of them miss every tick.
   */
  private dueBySchedule = new Map<string, number | null>()
  /** Which minute `dueBySchedule` describes. */
  private dueMinute = -1
  private disposed = false
  /**
   * Whether the first tick has run — before it, every job present is "already there at boot".
   *
   * A job whose clock is created on the first tick is one the panel started with. Any later creation
   * is a job someone declared while the panel was up, which has no missed occurrence to make up.
   */
  private booted = false

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
    // Every entry handed in is a job now: the caller is the jobs service, not a mixed server list.
    const jobs = this.options.servers()
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
    // Everything from here on is a job somebody added while the panel was already up.
    this.booted = true
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

    /**
     * The due-minute memo: the answer cannot change within a minute and the tick runs at 1 Hz, so a
     * rare expression would otherwise pay for the same look-back scan sixty times over (measured
     * ~80 ms for `0 0 31 4 *` before the day-skip, still tens of ms after).
     *
     * **Keyed by expression, in a map, for the current minute only.** A single slot was not enough:
     * with two jobs on *different* rare expressions each overwrote the other's entry, so neither ever
     * hit and both paid the full scan every tick (measured 390 ms/tick for two distinct impossible
     * schedules on the reviewer's machine, 18 ms on mine). "A handful of schedules" — the argument the
     * single slot rested on — is exactly the case that breaks it. Editing a schedule misses naturally.
     */
    const minute = Math.floor(now / 60_000)
    if (this.dueMinute !== minute) {
      this.dueMinute = minute
      this.dueBySchedule.clear()
    }
    let due: number | null
    if (this.dueBySchedule.has(schedule)) {
      due = this.dueBySchedule.get(schedule)!
    }
    else {
      due = previousCronRun(parsed.spec, new Date(now))
      this.dueBySchedule.set(schedule, due)
    }
    clock.due = due
    /**
     * A schedule can legitimately have **no** occurrence in the past year and still be valid: a leap
     * day (`0 0 29 2 *`) repeats every four years. The forward search separates the two — a real future
     * occurrence means the expression is fine and simply has nothing due yet, which deserves silence
     * rather than a standing warning about a broken schedule.
     */
    if (due === null && nextCronRun(parsed.spec, new Date(now)) !== null) {
      clock.reportedProblem = null
      return
    }
    if (due === null) {
      // The expression names a day that cannot occur (`0 0 31 4 *`).
      // `null` is "not within the search limit", not proof of "never": a date like 31 April cannot
      // occur, but a leap-day expression near a non-leap century year is merely far away. Saying
      // "never" for the second would be wrong, so the message states what was actually checked.
      this.reportOnce(clock, id, `the schedule has no occurrence in the past year and none within eight years (${schedule}) — check it is not an impossible date like 31 April`)
      return
    }

    // A usable expression clears any standing complaint, so a schedule fixed and later broken again is
    // reported again. It must run after both "nothing due" branches: resetting before them re-logged the
    // un-runnable case on every tick.
    clock.reportedProblem = null

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
     *
     * **A job declared while the panel is up is neither case.** It did not exist when the occurrence
     * went by, so nothing is owed — and marking it started here is what stops a fresh nightly backup
     * from running the moment it is saved. `seenAtBoot` is the discriminator: the clock is created on
     * the job's first tick, and only a clock created during the panel's own first tick belongs to a
     * job that was already there.
     */
    if (clock.lastStartedFor === null) {
      const lastRun = clock.lastRunAt ?? this.options.lastRunAt(id)
      clock.lastRunAt = lastRun
      if (!clock.seenAtBoot || (lastRun !== null && lastRun >= due)) {
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
    // `booted` is set at the end of the first tick, so every clock created *during* that tick belongs
    // to a job the panel started with.
    const clock: JobClock = { lastStartedFor: null, lastRunAt: null, lastExitCode: null, lastOverlapAt: null, reportedProblem: null, due: null, seenAtBoot: !this.booted }
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
