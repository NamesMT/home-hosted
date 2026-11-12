import type { ChildProcess } from 'node:child_process'
import type { ServerConfig } from '#src/shared/contracts'
import path from 'node:path'
import { projectDir } from '#src/helpers/paths'
import { resolveTemplates } from '#src/helpers/template'
import { forceKillTree, resolveCommand, resolveCwd, spawnManaged } from '#src/providers/process'
import { serverTemplateVars } from '#src/providers/server-vars'
import { LineSplitter } from '#src/services/log-buffer'

/**
 * Running an entry's `deploy` steps: in order, in its own environment, and stopping at the first
 * failure.
 *
 * The shape is `runBootstrap`'s — the panel has one idea of what a declared command is, and both are
 * "run this, stream its output into the entry's log, and let a stop interrupt it". What is different
 * is the **outcome**: a bootstrap is best-effort on the way to a start, while a deploy *is* the
 * action, so a failed step stops the sequence, notifies and leaves the running process alone —
 * half-deployed is the state this exists to avoid, and the old process is the thing a person still
 * has.
 */

/** What a deploy run produced. */
export interface DeployOutcome {
  ok: boolean
  /** Which step failed, 1-based, and its message — absent on success. */
  failedStep?: number
  error?: string
  /** How long every step took together. */
  durationMs: number
}

/** The seams a test needs: spawn, the log sink, the clock, and the environment. */
export interface DeployContext {
  log: (stream: 'stdout' | 'stderr' | 'system', text: string) => void
  /**
   * The environment every step runs with — the **entry's own**, resolved the way its spawn resolves
   * it: `env` < `envFile` < `dataEnvs` < `secretEnv`.
   *
   * Supplied rather than re-derived here, because only the supervisor holds the secrets store and the
   * `envFile` loader. Re-deriving a subset was a real defect: a step saw the tracked `env` and neither
   * `envFile` nor a declared secret, so a deploy needing a registry token silently ran without it —
   * while the comment claimed the opposite.
   *
   * A function, so it is resolved when the deploy runs rather than when it was configured.
   *
   * **Required**, deliberately. When it was optional the offline CLI path forgot it and silently fell
   * back to a subset — the exact bug this field was added to fix — so a caller now has to say what
   * environment its steps run with, even if the answer is "only the tracked `env` and `dataEnvs`".
   */
  env: () => Record<string, string>
  /** Injected so a test's child is real but the panel's process module is not. */
  spawn?: typeof spawnManaged
  now?: () => number
}

/**
 * Runs every step, then answers whether the whole deploy worked.
 *
 * **Never throws for a step failure** — a failed deploy is an outcome the caller records and reports,
 * not an exception that leaves a route halfway through its answer.
 *
 * `cancelled()` is re-checked between steps *and* while one runs: a stop during a deploy kills the
 * step's process group (`spawnManaged` gives it one), and the sequence ends there rather than
 * carrying on to install the second half of a stopped entry.
 */
export async function runDeploy(
  config: ServerConfig,
  cancel: { cancelled: () => boolean, onChild?: (child: ChildProcess | null) => void },
  context: DeployContext,
): Promise<DeployOutcome> {
  const started = context.now?.() ?? Date.now()
  const deploy = config.deploy
  if (deploy === undefined || deploy === null || deploy.steps.length === 0)
    return { ok: false, error: 'this entry has no deploy steps', durationMs: 0 }

  const spawnImpl = context.spawn ?? spawnManaged
  const vars = serverTemplateVars(config)
  const baseCwd = resolveCwd(config.cwd)

  for (const [index, step] of deploy.steps.entries()) {
    const position = index + 1
    if (cancel.cancelled())
      return { ok: false, failedStep: position, error: 'the deploy was stopped', durationMs: (context.now?.() ?? Date.now()) - started }

    // A step's own `cwd` is resolved the same way the entry's is, then against the entry's — so a
    // step may name a subdirectory, or a project-relative path, and both mean what they look like.
    const cwd = step.cwd === undefined ? baseCwd : path.resolve(baseCwd, step.cwd)
    const args = resolveTemplates(step.args, vars)
    const command = resolveCommand(step.command, cwd, projectDir)
    context.log('system', `deploy ${position}/${deploy.steps.length}: ${step.command} ${args.join(' ')}`.trim())

    // One splitter per stream, tagged `deploy` so a person reading the log sees which phase a line
    // came from — the same reason a bootstrap line is prefixed.
    // The line's own stream is kept: a deploy's stderr reading as stdout would hide the one thing a
    // failure is usually told by.
    const emit = (stream: 'stdout' | 'stderr' | 'system', text: string): void => {
      if (text.trim().length > 0)
        context.log(stream, `[deploy] ${text}`)
    }
    const stdout = new LineSplitter(emit)
    const stderr = new LineSplitter(emit)

    let child: ChildProcess
    try {
      // The entry's own environment, from the caller that resolved it — the same one the service
      // spawns with, so a step that needs a registry token reads the variable it already has.
      child = spawnImpl({ command, args, cwd, env: context.env() })
    }
    catch (error) {
      const message = (error as Error).message
      context.log('system', `deploy step ${position} could not start: ${message}`)
      return { ok: false, failedStep: position, error: message, durationMs: (context.now?.() ?? Date.now()) - started }
    }
    cancel.onChild?.(child)
    child.stdout?.on('data', chunk => stdout.push('stdout', chunk))
    child.stderr?.on('data', chunk => stderr.push('stderr', chunk))
    child.once('close', () => {
      stdout.flush('stdout')
      stderr.flush('stderr')
    })

    let timedOut = false
    let exitCode: number | null = null
    let spawnError: string | null = null
    /**
     * Resolves on exit, on an error, or **the moment the deploy is cancelled**.
     *
     * The cancellation poll is what makes a stop take effect: waiting only for `exit` meant the caller
     * was parked until the step's own timeout even though the stop had killed its process group, so
     * `POST /stop` appeared to hang for minutes. The poll is the caller's own `cancelled()` — cheap,
     * and it also covers a stop that raced the spawn.
     */
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true
        // Its own group, so a step that started something gets that too.
        forceKillTree(child)
      }, step.timeoutMs)
      // Declared before the closures that clear it: a child that exits on its first tick settles
      // before `poll` is assigned, and referencing it there would throw in the temporal dead zone.
      let poll: ReturnType<typeof setInterval> | undefined
      const settle = (): void => {
        clearTimeout(timer)
        if (poll !== undefined)
          clearInterval(poll)
        resolve()
      }
      poll = setInterval(() => {
        if (cancel.cancelled()) {
          forceKillTree(child)
          settle()
        }
      }, 100)
      child.once('exit', (code) => {
        exitCode = code
        settle()
      })
      child.once('error', (error) => {
        spawnError = (error as Error).message
        settle()
      })
    })
    cancel.onChild?.(null)

    if (cancel.cancelled()) {
      context.log('system', 'deploy stopped')
      return { ok: false, failedStep: position, error: 'the deploy was stopped', durationMs: (context.now?.() ?? Date.now()) - started }
    }
    if (timedOut) {
      const message = `step ${position} timed out after ${step.timeoutMs}ms`
      context.log('system', `deploy failed: ${message}`)
      return { ok: false, failedStep: position, error: message, durationMs: (context.now?.() ?? Date.now()) - started }
    }
    if (spawnError !== null && exitCode === null) {
      context.log('system', `deploy step ${position} did not run: ${spawnError}`)
      return { ok: false, failedStep: position, error: spawnError, durationMs: (context.now?.() ?? Date.now()) - started }
    }
    if (exitCode !== 0) {
      const message = `step ${position} exited with code ${exitCode}`
      context.log('system', `deploy failed: ${message}`)
      return { ok: false, failedStep: position, error: message, durationMs: (context.now?.() ?? Date.now()) - started }
    }
    context.log('system', `deploy step ${position}/${deploy.steps.length} finished`)
  }

  return { ok: true, durationMs: (context.now?.() ?? Date.now()) - started }
}
