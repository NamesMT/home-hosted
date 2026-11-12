import type { ChildProcess } from 'node:child_process'
import type { ResolvedSpawn } from '#src/services/supervisor/entry'
import { spawnManaged, terminate } from '#src/providers/process'
import { LineSplitter } from '#src/services/log-buffer'

/**
 * One run of a job: spawn it, wait for it, and let its exit status be the outcome.
 *
 * A job is a run-to-completion process, so almost nothing here is service machinery. There is no
 * readiness wait (nothing serves), no health probe (nothing stays up), no restart policy (a finished
 * run is not retried) and no adoption (a job that outlived the panel is a stranded process, not a
 * successor to take over). What a run has is a **start**, a bounded output stream, and an **exit
 * code** — and the exit code is the whole answer.
 *
 * The child gets its own output captured through pipes rather than the file transport used for
 * services (`supervisor/output.ts`). Those descriptors exist so a *service* survives the panel being
 * killed mid-run, which is a lifetime a job does not have: if the panel dies, the run is over as far
 * as anything can report it, and a leaked descriptor per run is worse than losing the tail of a log
 * nobody will read.
 */

/** How long one run may take before the panel ends it. Bounds a hung script, not a slow backup. */
export const JOB_TIMEOUT_MS = 60 * 60_000

export interface JobRunHandle {
  child: ChildProcess
  pid: number | null
  /** When the child was spawned — the start of the duration the history event records. */
  startedAt: number
  /** The exit, once the child is gone. Never rejects: a spawn failure resolves with `null`. */
  done: Promise<{ exitCode: number | null, signal: NodeJS.Signals | null }>
}

export interface JobSpawnOptions {
  log: (stream: 'stdout' | 'stderr' | 'system', text: string) => void
  /** A stop asked for this run's end, so the non-zero status that follows is not a failure. */
  cancelled: () => boolean
  timeoutMs?: number
}

/**
 * Spawns one job run and wires its output into the entry's log.
 *
 * Throws synchronously when the environment cannot run (`spawn` throws for an empty command, a NUL,
 * or a cwd that is a file) — the caller records that as the run's failure rather than a crash of the
 * panel. An asynchronous failure (`ENOENT` for a missing program) arrives on `'error'` and lands in
 * `done` as `exitCode: null`, which is the same answer a shell gives.
 */
export function spawnJobRun(resolved: ResolvedSpawn, options: JobSpawnOptions): JobRunHandle {
  const child = spawnManaged({ command: resolved.command, args: resolved.args, cwd: resolved.cwd, env: resolved.env })
  const startedAt = Date.now()

  // One splitter per stream, exactly as the service path has: a half-written stdout line must not
  // absorb stderr's.
  const stdout = new LineSplitter((stream, text) => options.log(stream, text))
  const stderr = new LineSplitter((stream, text) => options.log(stream, text))
  child.stdout?.on('data', chunk => stdout.push('stdout', chunk))
  child.stderr?.on('data', chunk => stderr.push('stderr', chunk))
  child.once('close', () => {
    // `close` is when both pipes have delivered everything, so an unterminated last line is not lost.
    stdout.flush('stdout')
    stderr.flush('stderr')
  })

  const done = new Promise<{ exitCode: number | null, signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled)
        return
      settled = true
      resolve({ exitCode, signal })
    }
    child.once('exit', (code, signal) => finish(code, signal))
    // A spawn that never happened emits no `exit`; without this the run would hang until the timeout.
    child.once('error', () => finish(null, null))
  })

  const timeoutMs = options.timeoutMs ?? JOB_TIMEOUT_MS
  // A hung job must not hold its slot for ever: the run ends, and the next occurrence is free to
  // start. `unref` so a panel that is stopping does not wait the timeout out.
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      options.log('system', `run exceeded ${Math.round(timeoutMs / 60_000)} min — stopping it`)
      void terminate(child, { signal: 'SIGTERM', killGroup: true, graceMs: 5000 }).catch(() => undefined)
    }
  }, timeoutMs)
  timer.unref()
  void done.finally(() => clearTimeout(timer))

  return { child, pid: child.pid ?? null, startedAt, done }
}

/**
 * Ends a run that a stop interrupted: the whole group goes, then `done` answers.
 *
 * Signalled as a group because a job is usually a script that started something (a `pg_dump` through
 * a shell, a `make`): signalling only the wrapper leaves the real work running beside the panel's
 * belief that the run is over.
 */
export async function stopJobRun(run: { child: ChildProcess, done: Promise<unknown> }, graceMs = 5000): Promise<void> {
  await terminate(run.child, { signal: 'SIGTERM', killGroup: true, graceMs })
  await run.done
}

/**
 * What a finished run reads as, in one line — the log line and the history event's `detail`.
 *
 * `0` succeeded and nothing else did; a signal is reported as the signal, because "exited with code
 * null" tells nobody anything. A cancelled run says so instead of dressing a stop up as a failure.
 */
export function describeJobOutcome(
  exitCode: number | null,
  signal: string | null,
  durationMs: number,
  cancelled: boolean,
): string {
  const took = `${Math.max(1, Math.round(durationMs / 1000))}s`
  if (cancelled)
    return `run stopped after ${took}`
  if (signal !== null)
    return `run killed by ${signal} after ${took}`
  return `run ${exitCode === 0 ? 'finished' : 'failed'} with exit code ${exitCode ?? '?'} after ${took}`
}
