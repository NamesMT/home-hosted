import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { processCarriesServerId } from '#src/providers/proc'
import { resolveCommand } from '#src/providers/process'

const execFileAsync = promisify(execFile)

/** What the panel actually spawned for an entry: the argv it has to recognize again. */
export interface SpawnInfo {
  command: string
  args: string[]
  cwd: string
}

/**
 * The argv a detached successor may have kept. Never logged or published: `${SECRET}`
 * in an argument is expanded here and the spawn path already logs the unexpanded form.
 */
export function resolveSpawn(config: { command: string, args: string[], cwd: string }, projectDir: string): SpawnInfo {
  const cwd = path.resolve(projectDir, config.cwd)
  return {
    command: resolveCommand(config.command, cwd, projectDir),
    // Never trimmed: an argument that is a space is still an argument.
    args: config.args.filter(arg => arg.length > 0),
    cwd,
  }
}

/**
 * Splits a command line into words, undoing the quoting Windows put there. `CommandLine`
 * is the raw string from the spawn call, so `"C:\a b\x.cmd" /c` is one argv entry plus
 * two words, and a quoted argument that contains spaces has to come back as one word.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = []
  let current = ''
  let quoted = false
  let started = false

  for (const char of line.trim()) {
    if (char === '"') {
      quoted = !quoted
      // A quote is both a delimiter and proof that a (possibly empty) word exists.
      started = true
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (started)
        words.push(current)
      current = ''
      started = false
      continue
    }
    current += char
    started = true
  }

  if (started)
    words.push(current)
  return words
}

function comparable(target: string): string {
  // Quotes around a whole word are stripped; whitespace never is. `resolveSpawn` only
  // drops *empty* arguments, so an argument of one space has to stay distinguishable
  // from a missing one — trimming it here would make them compare equal.
  const value = target.replace(/^"(.*)"$/, '$1')
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/** The same file spelled differently (`node`, `node.exe`, a relative path) compares equal. */
function sameWord(a: string, b: string): boolean {
  const left = comparable(a)
  const right = comparable(b)
  if (left === right || path.basename(left) === path.basename(right))
    return true
  return path.extname(b) === '' && path.basename(left, path.extname(left)) === right
}

/**
 * True when the argv a process is running is the entry's own: the image must match where
 * `spawn` would have looked it up — the image Path, or the first word of the command line
 * — and the remaining words must open with the entry's args in order. So `spawn --port
 * 4000` also covers `spawn -p 4000 --extra`, which is what a self-restarting wrapper does.
 *
 * `words` must already be the process's own argv. A `commandLine` string is only correct
 * on Windows, where the OS hands one out; `/proc/<pid>/cmdline` quotes are literal bytes
 * of an argument, so re-joining that argv into one string corrupts it.
 */
export function matchesSpawn(info: { words: string[], imagePath?: string | null }, spawn: SpawnInfo): boolean {
  const { words } = info

  // Via the image the argv is the whole command line; via the first word the image
  // itself is that word, so the args start after it.
  if (info.imagePath && sameWord(info.imagePath, spawn.command)
    && spawn.args.every((arg, index) => sameWord(words[index] ?? '', arg))) {
    return true
  }

  return sameWord(words[0] ?? '', spawn.command)
    && spawn.args.every((arg, index) => sameWord(words[index + 1] ?? '', arg))
}

/** The argv of a pid on the platforms whose process table can answer it; null otherwise. */
export async function processArgv(pid: number): Promise<string[] | null> {
  if (process.platform === 'win32')
    return null

  if (process.platform === 'linux') {
    try {
      const raw = await fs.promises.readFile(`/proc/${pid}/cmdline`)
      const argv = raw.toString('utf8').split('\0').filter(part => part.length > 0)
      return argv.length > 0 ? argv : null
    }
    catch {
      return null
    }
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-ww', '-o', 'command='], { timeout: 3000 })
    // macOS hands back one line, so it has to be split back into words here.
    const words = splitCommandLine(stdout.trim())
    return words.length > 0 ? words : null
  }
  catch {
    return null
  }
}

const windowsFilter = /^\d+$/

/** `Win32_Process` for one pid, or null when it cannot be read. */
export async function windowsProcessInfo(pid: number): Promise<{ commandLine: string, imagePath: string | null } | null> {
  if (!windowsFilter.test(String(pid)))
    return null

  try {
    const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object CommandLine,ExecutablePath | ConvertTo-Json -Compress`
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000, windowsHide: true })
    const parsed: unknown = JSON.parse(stdout.trim() || 'null')
    // A single hit comes back as an object; an empty result is null, not `[...]`.
    const record = (Array.isArray(parsed) ? parsed[0] : parsed) as { CommandLine?: unknown, ExecutablePath?: unknown } | null
    if (!record || typeof record.CommandLine !== 'string')
      return null
    return { commandLine: record.CommandLine, imagePath: typeof record.ExecutablePath === 'string' ? record.ExecutablePath : null }
  }
  catch {
    return null
  }
}

/**
 * Which of these pids look like this entry's own detached successor. The environment
 * marker is authoritative where the platform can read it; otherwise the answer rests on
 * the entry's own argv, which is the only signal a detached successor is obliged to keep
 * — and the only one Windows exposes at all.
 */
export async function identifyHolders(serverId: string, spawn: SpawnInfo, pids: number[]): Promise<number[]> {
  const found: number[] = []

  for (const pid of pids) {
    if (await processCarriesServerId(pid, serverId)) {
      found.push(pid)
      continue
    }

    // An empty argv proves nothing, so a marker is the only way in without it.
    if (spawn.args.length === 0)
      continue

    if (process.platform === 'win32') {
      const info = await windowsProcessInfo(pid)
      if (info && matchesSpawn({ words: splitCommandLine(info.commandLine), imagePath: info.imagePath }, spawn))
        found.push(pid)
      continue
    }

    const argv = await processArgv(pid)
    if (argv !== null && matchesSpawn({ words: argv }, spawn))
      found.push(pid)
  }

  return found
}
