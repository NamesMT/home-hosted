import type { JobConfig } from '#src/shared/contracts'
import fs from 'node:fs'
import { type } from 'arktype'
import { CONFIG_SCHEMA } from '#src/config/migrations'
import { ConfigError } from '#src/config/settings'
import { writeFileAtomic } from '#src/helpers/atomic'
import { readStateFile } from '#src/helpers/config-text'
import { duplicateSecretEnvNames, jobSchema, jobsFileSchema } from '#src/shared/contracts'
import { cronProblem } from '#src/shared/cron'
import { errorMessage } from '#src/shared/error-message'

/**
 * A workspace's jobs, read from `jobs.config.json`.
 *
 * Deliberately **not** a `WorkspaceStore`: that class carries settings, servers, live reload, conflict
 * detection, schema migrations and a migration ladder for two files. A jobs file is a flat list of
 * entries with one shape, and borrowing that machinery would mean inheriting its states (a partially
 * migrated config, a conflict with an outside edit) for a file that has never had a migration.
 *
 * What it does share is the parts that matter for correctness: the same atomic write, the same
 * refuse-to-overwrite-an-unparseable-file rule, and the same validation helper (`jobProblems`) called
 * on every write — so a job cannot be stored in a state this release cannot run.
 *
 * The file is read **per call** rather than cached: a person edits it by hand, and a panel that
 * answered from a stale cache would show a job that no longer exists. It is one small JSON file.
 */
export class JobStore {
  constructor(private readonly file: string) {}

  /** Where this store reads and writes. A backup captures exactly this file, not a re-derived name. */
  get path(): string {
    return this.file
  }

  /**
   * Every job, in the order the file lists them.
   *
   * Throws a `ConfigError` for a file this release cannot use — unparseable JSON, a shape problem, or
   * a job that fails `jobProblems` — because every caller needs to tell "no jobs" from "this file is
   * broken", and a silent `[]` would make the panel claim a workspace has no jobs when it has a typo.
   */
  list(): JobConfig[] {
    const raw = this.readDocument()
    const jobs = raw.jobs
    for (const job of jobs) {
      const problems = jobProblems(job)
      if (problems.length > 0)
        throw new ConfigError(`job "${job.id}" is not runnable: ${problems.join('; ')}`, 'INVALID_JOB')
    }
    return jobs
  }

  /** Every job, or `[]` when the file is absent — the normal state of a workspace with no jobs. */
  listOrEmpty(): JobConfig[] {
    return fs.existsSync(this.file) ? this.list() : []
  }

  /** One job, or `null`. Throws for a broken file, like `list`. */
  get(id: string): JobConfig | null {
    return this.list().find(job => job.id === id) ?? null
  }

  /**
   * Adds one, refusing a duplicate id.
   *
   * A duplicate id is the one mistake worth a distinct answer: a job id names its log file and its
   * history events, so two would interleave output that cannot be untangled afterwards.
   */
  add(input: JobConfig): JobConfig {
    const problems = jobProblems(input)
    if (problems.length > 0)
      throw new ConfigError(`job "${input.id}" is not runnable: ${problems.join('; ')}`, 'INVALID_JOB')
    const jobs = this.listOrEmpty()
    if (jobs.some(job => job.id === input.id))
      throw new ConfigError(`a job with the id "${input.id}" already exists in this workspace`, 'JOB_EXISTS')
    this.write([...jobs, input])
    return input
  }

  /** Replaces one by id. `null` when no job has it — a 404 is the caller's to answer. */
  update(id: string, patch: Partial<JobConfig> & { label?: string | null }): JobConfig | null {
    const jobs = this.listOrEmpty()
    const index = jobs.findIndex(job => job.id === id)
    if (index === -1)
      return null
    // `label: null` clears it, exactly as the servers file does, so a display falls back to the id.
    const merged = { ...jobs[index]!, ...patch } as Record<string, unknown>
    if (patch.label === null)
      delete merged.label
    const parsed = jobSchema(merged)
    if (parsed instanceof type.errors)
      throw new ConfigError(`job "${id}" would be invalid: ${parsed.summary}`, 'INVALID_JOB')
    const problems = jobProblems(parsed)
    if (problems.length > 0)
      throw new ConfigError(`job "${id}" would not be runnable: ${problems.join('; ')}`, 'INVALID_JOB')
    const next = [...jobs]
    next[index] = parsed
    this.write(next)
    return parsed
  }

  /** Removes one. `true` when it was there — its log and history are the caller's to clean up. */
  remove(id: string): boolean {
    const jobs = this.listOrEmpty()
    const next = jobs.filter(job => job.id !== id)
    if (next.length === jobs.length)
      return false
    this.write(next)
    return true
  }

  /** The document as this store writes it: the stamp every config in this repo carries. */
  private readDocument(): { jobs: JobConfig[] } {
    let text: string
    try {
      /**
       * `readStateFile`, not a `'utf8'` read: this file is hand-editable, and Windows Notepad writes a
       * UTF-8 BOM — measured, `jobs.config.json` with one answered *"is not readable JSON (Unexpected
       * token '\uFEFF')"*, so every job in it silently vanished for anyone who opened it in the editor
       * the platform ships. `servers.config.json` and `settings.json` already read through this helper;
       * `jobs.config.json`, added later to the same layer, did not.
       */
      text = readStateFile(this.file)
    }
    catch {
      // Absent is "no jobs", which `listOrEmpty` answers before reaching here.
      return { jobs: [] }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    }
    catch (error) {
      throw new ConfigError(`${this.file} is not readable JSON (${errorMessage(error)}) — it was left untouched`, 'INVALID_CONFIG')
    }
    const checked = jobsFileSchema(parsed)
    if (checked instanceof type.errors)
      throw new ConfigError(`${this.file} is not a jobs file: ${checked.summary}`, 'INVALID_CONFIG')
    return { jobs: checked.jobs }
  }

  /**
   * Writes the list, atomically.
   *
   * **Refuses to write over a file it cannot parse**: a hand-edit with a typo in it is somebody's work,
   * and replacing it with a clean list would destroy the entry they were in the middle of adding.
   */
  private write(jobs: JobConfig[]): void {
    if (fs.existsSync(this.file))
      this.readDocument()
    const document = {
      meta: { writtenBy: 'home-hosted', schema: CONFIG_SCHEMA },
      jobs,
    }
    writeFileAtomic(this.file, `${JSON.stringify(document, null, 2)}\n`)
  }
}

/**
 * What is wrong with one job, as a list — empty when it is runnable.
 *
 * A schema proves the field *shapes*; these are the relationships a schema cannot express without a
 * `narrow` (which breaks `toJsonSchema`, and every route's OpenAPI document calls it). The cron
 * contents are the important one: `cronExpressionSchema` proves five fields, and `cronProblem` proves
 * that the expression means something.
 */
export function jobProblems(job: { id?: string, schedule?: string, secretEnv?: string[] }): string[] {
  const problems: string[] = []
  if (job.schedule !== undefined) {
    const problem = cronProblem(job.schedule)
    if (problem !== null)
      problems.push(`schedule: ${problem}`)
  }
  if (job.secretEnv !== undefined) {
    const duplicate = duplicateSecretEnvNames(job.secretEnv)
    if (duplicate.length > 0)
      problems.push(`secretEnv names a variable twice: ${duplicate.join(', ')}`)
  }
  return problems
}
