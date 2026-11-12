import type { JobRunResultBody } from '#src/shared/contracts'
import process from 'node:process'
import { defineCommand } from 'citty'
import { dim, fail, green, invocation } from '#src/cli/io'

/**
 * `home-hosted run <id>` — run a job now, and report its outcome.
 *
 * **Waits, and exits 1 on failure**: a job's exit code *is* its outcome, and a command that answered
 * "accepted" would leave a caller believing a backup ran that did not. The run's own output goes to the
 * entry's log (`home-hosted logs <id>`), so this prints the outcome rather than streaming it back —
 * which is also why `--json` stays one document.
 *
 * Through the panel when it runs (its supervisor then owns the process, the history event and the
 * notification, exactly as the schedule's own occurrence does). Without a panel there is nothing to run
 * **a job in** — no supervisor, no log file, no history — so that case is refused rather than answered
 * with a second, unsupervised implementation that a person would believe was the panel's.
 */

export const runArgs = {
  id: { type: 'positional', required: false, description: 'the job id from the workspace\'s servers.config.json' },
  workspace: { type: 'string', alias: 'w', description: 'the workspace that owns it (default: the panel\'s default workspace)' },
  json: { type: 'boolean', description: 'print one document on stdout' },
} as const

export const runCommand = defineCommand({
  meta: { name: 'run' },
  args: runArgs,
  async run({ args }) {
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (id.length === 0)
      fail(`run needs a job id — see \`${invocation()} ls\``)
    const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : undefined
    const json = args.json === true
    const where = workspace === undefined || workspace.length === 0 ? '' : `?workspace=${encodeURIComponent(workspace)}`

    const { readRuntime, requestControl, runtimeIsAlive } = await import('#src/helpers/daemon')
    const runtime = readRuntime()
    if (runtime === null || !await runtimeIsAlive(runtime))
      fail(`home-hosted is not running — a job is run by the panel's supervisor, so start it with \`${invocation()} up\``)

    // A job runs for as long as it runs: the local channel waits for the outcome, so this timeout is
    // the transport's, not the run's (the panel ends a hung run on its own schedule).
    const answer = await requestControl(runtime, `/_hh/servers/${encodeURIComponent(id)}/run${where}`, 24 * 60 * 60_000, 'POST')
    if (answer === null)
      fail(`the control panel is not answering on ${runtime.probeUrl}`)

    const body = (answer.body ?? {}) as Partial<JobRunResultBody> & { message?: string, code?: string }

    if (answer.status !== 200) {
      // The panel's own sentence, which already names the fix (`NOT_A_JOB` says to use `start`). A
      // failed run keeps its numbers under `--json`, so a script reads the exit code rather than prose.
      const reason = body.message ?? `the panel answered ${answer.status}`
      if (json) {
        process.stdout.write(`${JSON.stringify({ server: id, ok: false, code: body.code, exitCode: body.exitCode ?? null, durationMs: body.durationMs ?? null, cancelled: body.cancelled ?? false, error: reason })}\n`)
        process.exitCode = 1
        return
      }
      fail(reason)
    }

    if (json) {
      process.stdout.write(`${JSON.stringify({ server: id, ok: true, exitCode: body.exitCode ?? null, signal: body.signal ?? null, durationMs: body.durationMs ?? 0, cancelled: body.cancelled === true })}\n`)
      return
    }
    process.stdout.write(`${green('ran')} ${id} — ${jobRunLine(body)}\n`)
    process.stdout.write(`${dim(`its output is in \`${invocation()} logs ${id}\``)}\n`)
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
