import type { ResolvedSpawn } from '#src/services/supervisor/entry'
import type { JobConfig, JobEntryView, LogLine, LogsConfig } from '#src/shared/contracts'
import path from 'node:path'
import process from 'node:process'
import { JobStore } from '#src/config/jobs'
import { logger } from '#src/helpers/logger'
import { projectDir, workspaceJobsLogsDir, workspaceJobsPath } from '#src/helpers/paths'
import { resolveRecord, resolveTemplates } from '#src/helpers/template'
import { resolveCommand, resolveCwd } from '#src/providers/process'
import { LogFiles } from '#src/services/log-files'
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

/**
 * The retention a job log gets when the caller passes none.
 *
 * The `logs` group's own defaults, spelled here rather than read from the schema so a service can be
 * built with no settings store at all (a test, a CLI caller). A panel always passes the workspace's.
 */
const DEFAULT_JOB_LOGS: LogsConfig = { persist: true, maxBytes: 2_000_000, keep: 3 }

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
  /**
   * Where a run's output is kept, and whether it is kept at all.
   *
   * The same `logs` group a workspace's servers obey: `persist` off writes no file, and `maxBytes`/
   * `keep` bound one. Omitted, this service keeps its own files under the workspace's own job-log
   * directory with the contract's defaults — which is what a test wants, and never what a panel
   * builds (it passes the workspace's settings).
   */
  logs?: () => LogsConfig
  /**
   * The directory those files live in. Omitted, it is the workspace's own job-log directory.
   *
   * A caller that already knows its root passes it the same way it passes `file`: `dataRoot` is a
   * module-level constant, so a test cannot redirect it, and deriving the directory from `file`'s
   * parent would put a fixture's logs next to its own `jobs.config.json` rather than under `.logs/`.
   */
  logDir?: string
  /** Notified when a job's state changes, so the panel publishes a frame. */
  onStateChange?: () => void
  /** A run finished: the caller records it in the workspace history and notifies on failure. */
  onRunFinished?: (job: JobConfig, record: JobRunRecord) => void
  /**
   * The stored secret values for a job's declared names — the job half of a server's `serverEnv`.
   *
   * `secretEnv` on the config is the **consent**: a name the job did not declare is never passed,
   * even when the workspace holds a value for a job of that id that has since been edited. That is
   * the same rule `src/services/supervisor/spawn.ts` applies to a server, and it has to be applied
   * here too — the names were accepted, stored and shown in the UI while `resolve()` ignored them
   * entirely, so a job declaring `MY_SECRET` ran without it and nobody was told.
   */
  serverEnv?: (jobId: string) => Record<string, string>
}

/**
 * Which of a job's declared names have a stored value — sorted, and **never** the values.
 *
 * One helper rather than an inline expression because it is the same question `serverView.secretEnvSet`
 * answers for a server, and the answer has to stay "names only": a view that leaked a value would undo
 * the whole point of the store.
 */
function secretEnvSetFor(reader: ((jobId: string) => Record<string, string>) | undefined, job: JobConfig): string[] {
  if (reader === undefined || job.secretEnv.length === 0)
    return []
  const stored = reader(job.id)
  return job.secretEnv.filter(name => stored[name] !== undefined).sort()
}

export class JobsService {
  private readonly store: JobStore
  private readonly scheduler: JobScheduler
  /**
   * One JSONL file per job id, in the workspace's own `jobs/` log directory.
   *
   * A run's output used to go to the panel log at DEBUG, which meant a failed backup's own output was
   * invisible: nobody runs the panel at debug level, so the one thing a person needs to debug a run
   * was the one thing not written. It is a `LogFiles` with the same rotation, the same tail reader and
   * the same retention a server's log has, under a directory of its own because a job id and a server
   * id are unique in different namespaces (`workspaceJobsLogsDir`).
   */
  private readonly logs: LogFiles
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
    this.logs = new LogFiles(options.logDir ?? workspaceJobsLogsDir(options.workspaceId), () => options.logs?.() ?? DEFAULT_JOB_LOGS)
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
        // The names a job declares, and which of them have a stored value — the pair a page needs to
        // render one value box per name. Values are never included: the store holds them, the view
        // only says whether one exists, exactly as `serverView.secretEnvSet` does.
        secretEnv: job.secretEnv,
        secretEnvSet: secretEnvSetFor(this.options.serverEnv, job),
        ...(job.timeoutMs === undefined ? {} : { timeoutMs: job.timeoutMs }),
        ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
        ...(job.env === undefined ? {} : { env: job.env }),
        // Where this job's runs write. Optional on the wire, and always answered: the view advertised
        // a `logPath` nothing served, which is worse than no field at all.
        logPath: this.logPath(job.id),
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
      // Written out before this resolves. `LogFiles` batches on a 250 ms timer, so without this a
      // caller that runs a job and then reads its log — the CLI, the API's own wait-for-exit, a page
      // that ran and refreshed — would be answered with a log that does not contain the run it just
      // watched. The batch is one job's, and a finished run is exactly when it should hit disk.
      this.logs.flush()
      return record
    }
    catch (error) {
      // A spawn that throws synchronously (an unusable command or cwd): a failed run, not a crash.
      const record: JobRunRecord = { startedAt, endedAt: Date.now(), exitCode: null, signal: null, cancelled: false }
      this.history.set(id, record)
      this.log(id, 'system', `run could not start: ${error instanceof Error ? error.message : String(error)}`)
      this.logs.flush()
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
    // Writes the batch that is still buffered: a run that ended a moment ago has its last lines in
    // memory, and a panel stopping is exactly when nobody will run that job again to produce them.
    this.logs.dispose()
    for (const running of this.running.values())
      void running.stop().catch(() => undefined)
  }

  /**
   * The environment and argv a job spawns with — its **own**, not a server's.
   *
   * A job has no `port`, no `bind` and no `envFile`, so it uses the template variables it can honestly
   * have (`{id}`, `{label}`, `{cwd}`, `{projectDir}`, `{dataRoot}`, `{home}`) and expands its `env`
   * through the same helper a service does.
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
    const env: Record<string, string> = { ...process.env as Record<string, string>, ...resolveRecord(job.env, vars) }
    // The declared secrets, and nothing else from the store — the same consent rule a server's spawn
    // applies. Without this a job's `secretEnv` was decorative: the names were accepted and stored,
    // the UI listed them as settable, and the run never saw a value.
    if (job.secretEnv.length > 0 && this.options.serverEnv !== undefined) {
      const stored = this.options.serverEnv(job.id)
      for (const name of job.secretEnv) {
        if (stored[name] !== undefined)
          env[name] = stored[name]
      }
    }
    return {
      command: resolveCommand(job.command, cwd, projectDir),
      args,
      cwd,
      env,
      loggedArgs: resolveTemplates(job.args, vars),
    }
  }

  /**
   * A run's output goes to the job's own file, and the summary lines to the panel's log.
   *
   * Both, and they are different things: the **file** is what a person debugging a failed run reads,
   * and the panel log keeps the system lines (started, finished, stopped) so an operator tailing the
   * panel sees that a job ran at all. The run's own stdout/stderr is *not* echoed into the panel log —
   * it used to be, at DEBUG, which nobody enables, so it was invisible in practice while still costing
   * a line per line when it was.
   */
  private log(id: string, stream: 'stdout' | 'stderr' | 'system', text: string): void {
    this.logs.append(id, { ts: Date.now(), stream, text })
    if (stream === 'system')
      logger.info(`job "${id}": ${text}`)
  }

  /**
   * A job's own log: the lines a run wrote, newest last.
   *
   * The same tail a server's log serves, from the same reader — so one window size, one rotation and
   * one retention rule cover both, and a page can show either without a second implementation.
   */
  async readLog(id: string, tail: number): Promise<LogLine[]> {
    return await this.logs.readTail(id, tail)
  }

  /** How much a job's log has on disk, and which files carry it. */
  logInfo(id: string): { enabled: boolean, sizeBytes: number, files: Array<{ name: string, sizeBytes: number }>, directory: string } {
    return { ...this.logs.info(id), directory: this.logs.directory }
  }

  /** The path a person would open on disk, whether or not a run has written one yet. */
  logPath(id: string): string {
    return path.join(this.logs.directory, `${id}.log`)
  }

  /** Drops a job's whole log, for the removal that must not leave its output behind. */
  clearLog(id: string): void {
    this.logs.clear(id)
  }
}
