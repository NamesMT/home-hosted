import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { processCarriesServerId } from '#src/providers/proc'

const execFileAsync = promisify(execFile)

/** What the panel actually spawned for an entry: the argv it has to recognize again. */
export interface SpawnInfo {
  command: string
  args: string[]
  cwd: string
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
  // Quotes around a whole word are stripped; whitespace never is. `SpawnInfo.args` is the
  // argv `spawn` was handed, where a whitespace argument is still an argument, so trimming
  // here would make it compare equal to a missing one.
  const value = target.replace(/^"(.*)"$/, '$1')
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/**
 * Literal comparison for an argument: the same string, modulo the case folding Windows
 * paths need and the surrounding quotes a command line may carry. Deliberately *not*
 * `sameWord`: folding an argument to its basename would let this entry's
 * `/srv/web/build/server.js` equal a stranger's `/tmp/evil/build/server.js`, and a match
 * here is what `reclaim` kills.
 */
function sameArg(a: string, b: string): boolean {
  return comparable(a) === comparable(b)
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
 * — and the words after it must open with the entry's args, compared literally. So
 * `spawn --port 4000` also covers `spawn -p 4000 --extra`, which is what a self-restarting
 * wrapper does, while `/tmp/evil/server.js` never covers `/srv/web/server.js`.
 *
 * `words` must already be the process's own argv. A command-line *string* is only correct
 * on Windows, where the OS hands one out; `/proc/<pid>/cmdline` quotes are literal bytes
 * of an argument, so re-joining that argv into one string corrupts it.
 */
export function matchesSpawn(info: { words: string[], imagePath?: string | null }, spawn: SpawnInfo): boolean {
  const { words } = info
  const first = words[0] ?? ''

  // The image may be the first word, or absent from the command line entirely — a shim or
  // an interpreter reports its own image while the argv still carries what we passed.
  const imageMatches = sameWord(first, spawn.command)
    || (info.imagePath != null && info.imagePath !== '' && sameWord(info.imagePath, spawn.command))
  if (!imageMatches)
    return false

  // `>` rather than `>=`: a process has to have *more* words than we have args, so an
  // argument can never be satisfied by a word that is not there.
  const offset = sameWord(first, spawn.command) ? 1 : 0
  if (words.length < spawn.args.length + offset)
    return false

  return spawn.args.every((arg, index) => sameArg(words[index + offset]!, arg))
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
    // macOS receives one line and has to split it back into words here. `ps` joins argv
    // with spaces and quotes none of them, so an argument that itself contains a space
    // cannot be told from two arguments — that entry then fails to match and blocks,
    // which is the safe direction to be wrong in.
    const words = splitCommandLine(stdout.trim())
    return words.length > 0 ? words : null
  }
  catch {
    return null
  }
}

const windowsFilter = /^\d+$/

/**
 * The first two rows of `ConvertTo-Csv` output: the header and the first record. PowerShell
 * quotes and doubles its way around CSV, so `a,"b""c"` is three fields with the second
 * reading `b"c`.
 */
function parseCsvRows(output: string): [string[] | null, string[] | null] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let index = 0; index < output.length; index++) {
    const char = output[index]!
    if (quoted) {
      if (char !== '"') {
        field += char
        continue
      }
      if (output[index + 1] === '"') {
        field += '"'
        index++
        continue
      }
      quoted = false
      continue
    }

    if (char === '"') {
      quoted = true
      continue
    }
    if (char === ',') {
      row.push(field)
      field = ''
      continue
    }
    if (char === '\n') {
      row.push(field.replace(/\r$/, ''))
      rows.push(row)
      row = []
      field = ''
      continue
    }
    field += char
  }

  if (field.length > 0 || row.length > 0)
    rows.push([...row, field.replace(/\r$/, '')])

  return [rows[0] ?? null, rows[1] ?? null]
}

/**
 * `Win32_Process` for one pid, or null when it cannot be read.
 *
 * The whole round trip — launching PowerShell, loading the CIM provider, serializing —
 * costs seconds on a cold runner, so the timeout is generous and the result is converted
 * to CSV rather than JSON: CSV survives a value that contains a quote or a newline, which
 * an argv legitimately can.
 */
export async function windowsProcessInfo(pid: number): Promise<{ commandLine: string, imagePath: string | null } | null> {
  if (!windowsFilter.test(String(pid)))
    return null

  try {
    const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object CommandLine,ExecutablePath | ConvertTo-Csv -NoTypeInformation`
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20000, windowsHide: true })
    const [headers, values] = parseCsvRows(stdout)
    if (!headers || !values)
      return null

    const commandLineIndex = headers.indexOf('CommandLine')
    const imageIndex = headers.indexOf('ExecutablePath')
    const commandLine = commandLineIndex >= 0 ? values[commandLineIndex] : undefined
    if (commandLine === undefined || commandLine.length === 0)
      return null

    const imagePath = imageIndex >= 0 ? values[imageIndex] : undefined
    return { commandLine, imagePath: imagePath && imagePath.length > 0 ? imagePath : null }
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
