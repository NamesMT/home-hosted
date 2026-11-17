import type { JobRunResultBody } from '#src/shared/contracts'
import process from 'node:process'
import { defineCommand } from 'citty'
import { dim, fail, green, invocation, paint } from '#src/cli/io'
import { formatClockIso } from '#src/shared/ui-format'

/**
 * `home-hosted job` — a workspace's jobs: list them, and run one.
 *
 * A job is its own domain now: it lives in `jobs.config.json`, has its own page and its own API, and
 * it is no longer a `kind: "job"` server entry. This command is the terminal's way in, beside
 * `Job ls` on a page.
 *
 * `job run` **waits, and exits 1 on failure**: a job's exit code *is* its outcome, and a command that
 * answered "accepted" would leave a caller believing a backup ran that it did not. The run's own
 * output goes to the panel's log, so this prints the outcome rather than streaming it back — which is
 * also why `--json` stays one document.
 *
 * Through the panel when it runs: the panel owns the process, the history event and the notification,
 * exactly as the schedule's own occurrence does. Without a panel there is nothing to run a job **in**
 * — no scheduler, no history — so that case is refused rather than answered with a second,
 * unsupervised implementation a person would believe was the panel's.
 */

const workspaceArg = { type: 'string', alias: 'w', description: 'the workspace that owns it (default: the panel\'s default workspace)' } as const

/** `home-hosted job ls` — what is scheduled, and what it is doing. */
export const jobListCommand = defineCommand({
  meta: { name: 'ls' },
  args: {
    workspace: workspaceArg,
    json: { type: 'boolean', description: 'print one document on stdout' },
  },
  async run({ args }) {
    const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : undefined
    // Through `/_hh`, like every other CLI read. This used the **browser** client's `listJobs`,
    // whose `/api/jobs` is a relative URL a terminal cannot resolve — the command died with
    // "Failed to parse URL from /api/jobs" before it ever reached a panel.
    const { readRuntime, requestControl, runtimeIsAlive } = await import('#src/helpers/daemon')
    const runtime = readRuntime()
    if (runtime === null || !await runtimeIsAlive(runtime))
      fail(`home-hosted is not running — jobs live in the panel, so start it with \`${invocation()} up\``)

    const where = workspace === undefined || workspace.length === 0 ? '' : `?workspace=${encodeURIComponent(workspace)}`
    const answer = await requestControl(runtime, `/_hh/jobs${where}`, 15_000, 'GET')
    if (answer === null)
      fail(`the control panel is not answering on ${runtime.probeUrl}`)
    if (answer.status !== 200) {
      const body = (answer.body ?? {}) as { message?: string }
      fail(body.message ?? `the panel answered ${answer.status}`)
    }

    const { jobs } = (answer.body ?? { jobs: [] }) as { jobs: Array<{ id: string, schedule: string, running: boolean, enabled: boolean, nextRunAt?: number | null }> }
    if (args.json === true) {
      process.stdout.write(`${JSON.stringify({ jobs })}\n`)
      return
    }
    if (jobs.length === 0) {
      process.stdout.write(`${dim(`no jobs declared — declare one in jobs.config.json, or from the Jobs page`)}\n`)
      return
    }
    // A header, because three of the four columns are now values a person compares across rows.
    process.stdout.write(`${dim(`${'ID'.padEnd(20)} ${'SCHEDULE'.padEnd(16)} ${'NEXT'.padEnd(18)} STATE`)}
`)
    for (const job of jobs) {
      const state = job.running ? 'running' : job.enabled ? 'scheduled' : 'disabled'
      // `NEXT` earns its column: `docs/CLI.md` sends a person here to ask when something is due
      // ("the `NEXT RUN` column it used to grow is gone — `job ls` answers that question now"), and
      // the table answered everything except that. `null` nextRunAt is a real answer — an expression
      // that cannot come due — so it prints as `never` rather than a dash that reads as "loading".
      const next = job.enabled ? relativeToNow(job.nextRunAt) : '—'
      process.stdout.write(`${job.id.padEnd(20)} ${job.schedule.padEnd(16)} ${next.padEnd(18)} ${state}\n`)
    }
  },
})

/**
 * `in 3 minutes` / `in 18 hours` / `in 45 days` / `never`, from the epoch ms the view carries.
 *
 * Relative rather than absolute because the question a person asks at a terminal is "when next",
 * and a wall-clock stamp makes them subtract today's date. `Intl.RelativeTimeFormat` does the wording,
 * so a locale does not get hand-built English.
 */
function relativeToNow(at: number | null | undefined): string {
  if (at === null || at === undefined)
    return 'never'
  const minutes = Math.round((at - Date.now()) / 60_000)
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (Math.abs(minutes) < 60)
    return format.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 48)
    return format.format(hours, 'hour')
  return format.format(Math.round(hours / 24), 'day')
}

/** `home-hosted job run <id>` — run one now, and report its exit code. */
export const jobRunCommand = defineCommand({
  meta: { name: 'run' },
  args: {
    id: { type: 'positional', required: false, description: 'the job id from the workspace\'s jobs.config.json' },
    workspace: workspaceArg,
    json: { type: 'boolean', description: 'print one document on stdout' },
  },
  async run({ args }) {
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (id.length === 0)
      fail(`job run needs a job id — see \`${invocation()} job ls\``)
    const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : undefined
    const json = args.json === true
    const where = workspace === undefined || workspace.length === 0 ? '' : `?workspace=${encodeURIComponent(workspace)}`

    const { readRuntime, requestControl, runtimeIsAlive } = await import('#src/helpers/daemon')
    const runtime = readRuntime()
    if (runtime === null || !await runtimeIsAlive(runtime))
      fail(`home-hosted is not running — a job is run by the panel, so start it with \`${invocation()} up\``)

    // A job runs for as long as it runs: the local channel waits for the outcome, so this timeout is
    // the transport's, not the run's (the panel ends a hung run on its own schedule).
    const answer = await requestControl(runtime, `/_hh/jobs/${encodeURIComponent(id)}/run${where}`, 24 * 60 * 60_000, 'POST')
    if (answer === null)
      fail(`the control panel is not answering on ${runtime.probeUrl}`)

    const body = (answer.body ?? {}) as Partial<JobRunResultBody> & { message?: string, code?: string }

    if (answer.status !== 200) {
      // The panel's own sentence, which already names the fix (`NOT_A_JOB` says to use `start`). A
      // failed run keeps its numbers under `--json`, so a script reads the exit code rather than prose.
      const reason = body.message ?? `the panel answered ${answer.status}`
      if (json) {
        process.stdout.write(`${JSON.stringify({ job: id, ok: false, code: body.code, exitCode: body.exitCode ?? null, durationMs: body.durationMs ?? null, cancelled: body.cancelled ?? false, error: reason })}\n`)
        process.exitCode = 1
        return
      }
      fail(reason)
    }

    if (json) {
      process.stdout.write(`${JSON.stringify({ job: id, ok: body.exitCode === 0 && body.cancelled !== true, exitCode: body.exitCode ?? null, signal: body.signal ?? null, durationMs: body.durationMs ?? 0, cancelled: body.cancelled === true })}\n`)
      // A job's exit code **is** its outcome: `job run` promises to exit 1 on failure, and a backup
      // script reads exactly that. The old code only set this when the *request* failed, so a job
      // that ran and exited 1 printed "ran qa-fail — exit code 1" and then exited 0 itself.
      if (body.exitCode !== 0 || body.cancelled === true)
        process.exitCode = 1
      return
    }
    process.stdout.write(`${green('ran')} ${id} — ${jobRunLine(body)}\n`)
    // The job's **own** log, not the panel's: a run's output is written to `<id>.log` under the
    // workspace's job-log directory, and the panel log keeps only the summary lines. Sending a person
    // to the panel log to find their script's output is how this command's own message was wrong.
    process.stdout.write(`${dim(`its output is in the job's own log — \`${invocation()} job log ${id}\``)}\n`)
    if (body.exitCode !== 0 || body.cancelled === true)
      process.exitCode = 1
  },
})

/** `exit code 0 after 2s`, `killed by SIGTERM after 1s`, `stopped after 3s` — one sentence, one owner. */
export function jobRunLine(outcome: { exitCode?: number | null, signal?: string | null, durationMs?: number, cancelled?: boolean }): string {
  const took = `${Math.max(1, Math.round((outcome.durationMs ?? 0) / 1000))}s`
  if (outcome.cancelled === true)
    return `stopped after ${took}`
  if (outcome.signal !== null && outcome.signal !== undefined)
    return `killed by ${outcome.signal} after ${took}`
  return `exit code ${outcome.exitCode ?? '?'} after ${took}`
}

/** `home-hosted job log <id>` — what this job's runs wrote, newest last. */
export const jobLogCommand = defineCommand({
  meta: { name: 'log' },
  args: {
    id: { type: 'positional', required: false, description: 'the job id from the workspace\'s jobs.config.json' },
    workspace: workspaceArg,
    json: { type: 'boolean', description: 'print one document on stdout' },
  },
  async run({ args }) {
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (id.length === 0)
      fail(`job log needs a job id — see \`${invocation()} job ls\``)
    const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : undefined

    const { readRuntime, requestControl, runtimeIsAlive } = await import('#src/helpers/daemon')
    const runtime = readRuntime()
    if (runtime === null || !await runtimeIsAlive(runtime))
      fail(`home-hosted is not running — a job's log is written by the panel, so start it with \`${invocation()} up\``)

    const where = workspace === undefined || workspace.length === 0 ? '' : `?workspace=${encodeURIComponent(workspace)}`
    const answer = await requestControl(runtime, `/_hh/jobs/${encodeURIComponent(id)}/log${where}`, 15_000, 'GET')
    if (answer === null)
      fail(`the control panel is not answering on ${runtime.probeUrl}`)
    if (answer.status !== 200) {
      const body = (answer.body ?? {}) as { message?: string }
      fail(body.message ?? `the panel answered ${answer.status}`)
    }

    const body = (answer.body ?? { lines: [] }) as { enabled?: boolean, lines: Array<{ ts: number, stream: string, text: string }> }
    // `--json` prints **one document on stdout or nothing**, so an empty log is `{ lines: [] }` rather
    // than silence — a caller branching on it must not read "not a log" from "no output".
    if (args.json === true) {
      process.stdout.write(`${JSON.stringify({ job: id, lines: body.lines ?? [] })}\n`)
      return
    }
    if (body.enabled === false) {
      process.stdout.write(`${dim('the panel keeps no job logs — enable "persist" in the workspace log settings')}\n`)
      return
    }
    const lines = body.lines ?? []
    if (lines.length === 0) {
      process.stdout.write(`${dim(`no output yet — this job has not run since it was declared`)}`)
      process.stdout.write('\n')
      return
    }
    for (const line of lines) {
      // Local, like every other stamp the CLI prints. `toISOString()` here showed a job's run lines in
      // UTC while the run's own `next`/`last` columns were local — the same run read two hours apart.
      const stamp = formatClockIso(line.ts)
      process.stdout.write(`${dim(stamp)} ${line.stream === 'stderr' ? paint('31', line.stream) : line.stream.padEnd(6)} ${line.text}\n`)
    }
  },
})

/** The `job` group: `ls`, `run`, `log`. */
export const jobCommand = defineCommand({
  meta: { name: 'job' },
  subCommands: { ls: jobListCommand, run: jobRunCommand, log: jobLogCommand },
})
