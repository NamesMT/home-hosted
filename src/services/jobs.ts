import type { ResolvedSpawn } from '#src/services/supervisor/entry'
import type { JobConfig, JobEntryView } from '#src/shared/contracts'
import process from 'node:process'
import { JobStore } from '#src/config/jobs'
import { logger } from '#src/helpers/logger'
import { projectDir, workspaceJobsPath } from '#src/helpers/paths'
import { resolveRecord, resolveTemplates } from '#src/helpers/template'
import { resolveCommand, resolveCwd } from '#src/providers/process'
import { JobScheduler } from '#src/services/scheduler'
import { spawnJobRun, stopJobRun } from '#src/services/supervisor/job-run'
import { nextCronRun, parseCron } from '#src/shared/cron'

/**
 * A workspace's **jobs**: short-lived commands on cron schedules, and running them.
 *
 * This is the domain that came out of `kind: "job"` on a server entry. A job is not a service — it
 * starts, it runs, it exits, and its **exit code is the outcome** — so it has its own store, its own
 * scheduler, its own log and its own page, and the Servers page no longer explains any of it.
 *
 * What it borrows from the supervisor is only what is genuinely shared: `spawnJobRun` (a bounded
 * output stream and an exit code), `JobScheduler` (occurrence bookkeeping) and the cron parser. What
 * it deliberately does not borrow is the service lifecycle — no readiness wait, no health probe, no
 * restart policy, no nanny — because a job has none of those.
 */

/** Where a run's output goes. One file per job id, so a job's history is readable on its own. */
export interface JobRunRecord {
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  signal: string | null
  cancelled: boolean
}

/** What the jobs service needs from the panel; nothing wider. */
export interface JobsServiceOptions {
  workspaceId: string
  /**
   * Where the jobs file is. Omitted, the panel's own path graph resolves it.
   *
   * A caller that already knows its root (the API test fixture, a project with its own home) passes it
   * rather than setting `HHOSTED_HOME`: `dataRoot` is a module-level constant, so an env var set after
   * import would resolve to the default home — which is somebody's real one.
   */
  file?: string
  /** Notified when a job's state changes, so the panel publishes a frame. */
  onStateChange?: () => void
  /** A run finished: the caller records it in the workspace history and notifies on failure. */
  onRunFinished?: (job: JobConfig, record: JobRunRecord) => void
}

export class JobsService {
  private readonly store: JobStore
  private readonly scheduler: JobScheduler
  /** One run in flight per job id — the same rule the supervisor applies, at this level. */
  /**
   * One entry per run in flight.
   *
   * `cancelled` is an explicit flag, not a comparison of `startedAt`: two runs of the same job can
   * begin in the same millisecond, and "the timestamp changed" would then call a healthy run stopped.
   */
  private readonly running = new Map<string, { startedAt: number, cancelled: boolean, stop: () => Promise<void> }>()
  private readonly history = new Map<string, JobRunRecord>()
  private disposed = false

  constructor(private readonly options: JobsServiceOptions) {
    this.store = new JobStore(options.file ?? workspaceJobsPath(options.workspaceId))
    this.scheduler = new JobScheduler({
      // Every job in the file, whether enabled or not: the scheduler skips a disabled one itself, and
      // handing it the whole list keeps "which jobs exist" in one place.
      servers: () => this.store.listOrEmpty(),
      isRunning: id => this.running.has(id),
      // The scheduler only needs the exit code; `run` answers the whole record.
      run: async (id) => {
        const record = await this.run(id)
        return { exitCode: record?.exitCode ?? null }
      },
      noteOverlap: (id, occurrence) => {
        logger.warn(`job "${id}": skipped the run due at ${new Date(occurrence).toLocaleString()} — the previous one is still going`)
      },
      lastRunAt: id => this.history.get(id)?.endedAt ?? null,
      onStateChange: () => this.options.onStateChange?.(),
    })
  }

  /** Every job, with what it is doing — what a page lists. */
  list(): JobEntryView[] {
    const now = Date.now()
    return this.store.listOrEmpty().map((job) => {
      const record = this.history.get(job.id)
      const parsed = parseCron(job.schedule)
      return {
        id: job.id,
        ...(job.label === undefined || job.label === null ? {} : { label: job.label }),
        enabled: job.enabled,
        command: job.command,
        args: job.args,
        schedule: job.schedule,
        nextRunAt: parsed.ok ? nextCronRun(parsed.spec, new Date(now)) : null,
        ...(record?.endedAt === undefined || record?.endedAt === null ? {} : { lastRunAt: record.endedAt }),
        ...(record === undefined ? {} : { lastExitCode: record.exitCode }),
        running: this.running.has(job.id),
      }
    })
  }

  /** The store, for a route that creates, edits or removes a job. */
  get jobs(): JobStore {
    return this.store
  }

  /** One job, or `null`. */
  get(id: string): JobConfig | null {
    return this.store.listOrEmpty().find(job => job.id === id) ?? null
  }

  /**
   * Runs a job **now**, and resolves when it has ended.
   *
   * Never throws for a failed run: the exit code is the outcome, so a non-zero status is an answer.
   * It answers `null` when the job is already running or does not exist — the caller turns that into
   * the refusal it prefers.
   */
  async run(id: string): Promise<JobRunRecord | null> {
    if (this.disposed || this.running.has(id))
      return null
    const job = this.get(id)
    if (job === null)
      return null

    const startedAt = Date.now()
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const current = { startedAt, cancelled: false, stop: async () => {
      // The handle appears once the child exists; waiting for it keeps a stop that lands in the
      // first few milliseconds from doing nothing.
      await started
      const child = this.children.get(id)
      if (child !== undefined)
        await stopJobRun(child)
    } }
    this.running.set(id, current)

    try {
      const spawned = spawnJobRun(this.resolve(job), {
        log: (stream, text) => this.log(id, stream, text),
        cancelled: () => current.cancelled,
        timeoutMs: job.timeoutMs,
      })
      this.children.set(id, spawned)
      markStarted()
      const outcome = await spawned.done
      const cancelled = current.cancelled
      const record: JobRunRecord = {
        startedAt,
        endedAt: Date.now(),
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        cancelled,
      }
      this.history.set(id, record)
      this.options.onRunFinished?.(job, record)
      const seconds = Math.round(((record.endedAt ?? Date.now()) - startedAt) / 1000)
      this.log(id, 'system', cancelled
        ? 'run stopped'
        : outcome.exitCode === 0
          ? `run finished in ${seconds}s`
          : `run failed with exit code ${outcome.exitCode ?? outcome.signal ?? 'unknown'}`)
      return record
    }
    catch (error) {
      // A spawn that throws synchronously (an unusable command or cwd): a failed run, not a crash.
      const record: JobRunRecord = { startedAt, endedAt: Date.now(), exitCode: null, signal: null, cancelled: false }
      this.history.set(id, record)
      this.log(id, 'system', `run could not start: ${error instanceof Error ? error.message : String(error)}`)
      this.options.onRunFinished?.(job, record)
      return record
    }
    finally {
      this.children.delete(id)
      this.running.delete(id)
      this.options.onStateChange?.()
    }
  }

  /** The child of a run in flight, so a stop can end its whole group. */
  private readonly children = new Map<string, { child: import('node:child_process').ChildProcess, done: Promise<unknown> }>()

  /** Stops a run in flight. `false` when nothing was running. */
  async stop(id: string): Promise<boolean> {
    const running = this.running.get(id)
    if (running === undefined)
      return false
    running.cancelled = true
    await running.stop()
    return true
  }

  /**
   * When an expression next comes due, for the servers view and the `ls` column that still reports it.
   *
   * The supervisor asks this while describing an entry; with jobs extracted there is nothing for it to
   * answer, but keeping the seam means the panel does not have to know that — it is `null`, honestly.
   */
  nextRunAt(schedule: string | undefined): number | null {
    if (schedule === undefined)
      return null
    const parsed = parseCron(schedule)
    return parsed.ok ? nextCronRun(parsed.spec, new Date()) : null
  }

  /** One scheduler pass — the panel's own 1 Hz tick. */
  tick(now = Date.now()): void {
    if (this.disposed)
      return
    try {
      this.scheduler.tick(now)
    }
    catch (error) {
      // A broken jobs file must not take the tick loop down with it: the page reports the file, and
      // every other workspace keeps scheduling.
      logger.error(`workspace "${this.options.workspaceId}": the jobs file could not be read`, error)
    }
  }

  dispose(): void {
    this.disposed = true
    this.scheduler.dispose()
    for (const running of this.running.values())
      void running.stop().catch(() => undefined)
  }

  /**
   * The environment and argv a job spawns with — its **own**, not a server's.
   *
   * A job has no `port`, no `bind` and no `envFile`, so it uses the template variables it can honestly
   * have (`{id}`, `{label}`, `{cwd}`, `{projectDir}`, `{dataRoot}`, `{home}`) and expands its `env` and
   * `dataEnvs`-equivalent through the same helper a service does.
   */
  private resolve(job: JobConfig): ResolvedSpawn {
    const cwd = resolveCwd(job.cwd)
    const vars = {
      id: job.id,
      label: job.label ?? job.id,
      cwd,
      projectDir,
      dataRoot: process.env.HHOSTED_HOME ?? '',
      home: process.env.HOME ?? '',
    }
    const args = resolveTemplates(job.args, vars)
    return {
      command: resolveCommand(job.command, cwd, projectDir),
      args,
      cwd,
      env: { ...process.env as Record<string, string>, ...resolveRecord(job.env, vars) },
      loggedArgs: resolveTemplates(job.args, vars),
    }
  }

  /** A run's output goes to the panel's log, tagged with the job id. */
  private log(id: string, stream: 'stdout' | 'stderr' | 'system', text: string): void {
    if (stream === 'system')
      logger.info(`job "${id}": ${text}`)
    else
      logger.debug(`job "${id}" ${stream}: ${text}`)
  }
}
