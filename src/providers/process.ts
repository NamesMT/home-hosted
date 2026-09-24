import type { ChildProcess } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { projectDir } from '#src/helpers/paths'

const execFileAsync = promisify(execFile)

export interface SpawnSpec {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

/**
 * Resolves a bare command through the entry's own directory and the project's
 * `node_modules/.bin` first, so a server installed as a project dependency is
 * found even when the launcher's PATH has no pnpm-injected bin dir.
 */
export function resolveCommand(command: string, ...searchDirs: string[]): string {
  if (command.includes('/') || command.includes('\\'))
    return command

  for (const dir of searchDirs) {
    const local = path.join(dir, 'node_modules', '.bin', command)
    if (fs.existsSync(local))
      return local
  }

  return command
}

/** Relative entry paths belong to the project that launched the panel. */
export function resolveCwd(cwd: string, base: string = projectDir): string {
  return path.resolve(base, cwd)
}

export function spawnManaged(spec: SpawnSpec): ChildProcess {
  return spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    // Own process group: a stop can signal the whole tree with one kill(-pid).
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

export interface TerminateOptions {
  signal: NodeJS.Signals
  killGroup: boolean
  graceMs: number
}

/** SIGTERM (default) to the child, escalating to SIGKILL after the grace period. */
export async function terminate(child: ChildProcess, options: TerminateOptions): Promise<'exited' | 'force-killed'> {
  if (child.exitCode !== null || child.signalCode !== null)
    return 'exited'

  const exited = waitForExit(child, options.graceMs)
  signalChild(child, options.signal, options.killGroup)

  if (await exited)
    return 'exited'

  signalChild(child, 'SIGKILL', options.killGroup)
  await waitForExit(child, 2000)
  return 'force-killed'
}

/**
 * Windows has no process groups and no SIGTERM: `taskkill /T` walks the tree and
 * `/F` is the only reliable way to stop a console process.
 */
export async function killTreeWindows(pid: number): Promise<void> {
  try {
    await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 5000 })
  }
  catch {
    // Already gone, or taskkill is unavailable.
  }
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals, killGroup: boolean): void {
  const pid = child.pid
  if (pid === undefined)
    return

  if (process.platform === 'win32') {
    if (killGroup) {
      void killTreeWindows(pid)
    }
    else {
      try {
        process.kill(pid, signal)
      }
      catch {
        // already exited
      }
    }
    return
  }

  if (killGroup) {
    try {
      process.kill(-pid, signal)
      return
    }
    catch {
      // group already gone, fall through to the single pid
    }
  }

  try {
    process.kill(pid, signal)
  }
  catch {
    // already exited
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true)
  if (timeoutMs <= 0)
    return Promise.resolve(false)

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolve(false)
    }, timeoutMs)

    function onExit(): void {
      clearTimeout(timer)
      resolve(true)
    }

    child.once('exit', onExit)
  })
}
