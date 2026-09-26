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

/** Windows resolves a project-local bin to one of these shims, not the bare name. */
const WINDOWS_SHIM_EXTENSIONS = ['.cmd', '.exe', '.bat', '.ps1']

/**
 * Resolves a bare command through the entry's own directory and the project's
 * `node_modules/.bin` first, so a server installed as a project dependency is
 * found even when the launcher's PATH has no pnpm-injected bin dir.
 */
export function resolveCommand(command: string, ...searchDirs: string[]): string {
  if (command.includes('/') || command.includes('\\'))
    return command

  const candidates = process.platform === 'win32' && path.extname(command) === ''
    ? [command, ...WINDOWS_SHIM_EXTENSIONS.map(extension => `${command}${extension}`)]
    : [command]

  for (const dir of searchDirs) {
    for (const candidate of candidates) {
      const local = path.join(dir, 'node_modules', '.bin', candidate)
      if (fs.existsSync(local))
        return local
    }
  }

  return command
}

/** Relative entry paths belong to the project that launched the panel. */
export function resolveCwd(cwd: string, base: string = projectDir): string {
  return path.resolve(base, cwd)
}

/** Node cannot spawn a Windows `.cmd`/`.bat` shim without a shell (EINVAL). */
export function needsShell(command: string): boolean {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
}

export interface SpawnOptions {
  /**
   * A supervised child gets its own process group, so one `kill(-pid)` stops the tree.
   * A child spawned by a nanny does not: it shares the nanny's group, which is the
   * group the panel signals — so the same one-signal semantics still reach both.
   */
  detached?: boolean
}

export function spawnManaged(spec: SpawnSpec, options: SpawnOptions = {}): ChildProcess {
  return spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    // Own process group: a stop can signal the whole tree with one kill(-pid).
    detached: options.detached ?? true,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: needsShell(spec.command),
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
  signalPid(pid, signal, killGroup)
}

function signalPid(pid: number, signal: NodeJS.Signals, killGroup: boolean): void {
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

/**
 * The same shutdown a supervised child gets, for a process we adopted instead of
 * spawned: a detached successor is not our child, so it is signalled by pid (and
 * by process group when asked) and its exit is polled rather than awaited.
 */
export async function terminatePid(pid: number, options: TerminateOptions): Promise<'exited' | 'force-killed'> {
  if (!alive(pid))
    return 'exited'

  signalPid(pid, options.signal, options.killGroup)

  const deadline = Date.now() + Math.max(0, options.graceMs)
  while (Date.now() < deadline && alive(pid))
    await delay(50)
  if (!alive(pid))
    return 'exited'

  signalPid(pid, 'SIGKILL', options.killGroup)
  const hardDeadline = Date.now() + 2000
  while (Date.now() < hardDeadline && alive(pid))
    await delay(50)
  return 'force-killed'
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
