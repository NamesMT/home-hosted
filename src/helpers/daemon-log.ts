import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * The panel's own console log — the file `up` redirects the daemon's stdout/stderr into.
 *
 * It is the only record of a panel that is running but misbehaving, and nothing could reach
 * it: `up` prints it when the panel *fails to start*, and after that a person had to know the
 * path (which `status` does print) and read the bytes themselves.
 *
 * These live here rather than in `up.ts` so `up` and `logs` share one rotation rule and one
 * idea of what a "tail" is.
 */

/** One rotation is enough for a console log. */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024

export function rotateLog(file: string): void {
  try {
    if (fs.statSync(file).size < LOG_ROTATE_BYTES)
      return
    fs.rmSync(`${file}.1`, { force: true })
    fs.renameSync(file, `${file}.1`)
  }
  catch {
    // no log yet
  }
}

/**
 * The last `lines` lines, or `''` when there is no log to read.
 *
 * Split on the trailing newline rather than after it: a log file ends with one, so a plain
 * `split('\n').slice(-lines)` counts that empty last element as a line and quietly returns
 * one fewer than asked for.
 */
export function tailLog(file: string, lines = 15): string {
  return withoutTrailingBlank(readLogLines(file)).slice(-lines).join('\n')
}

function readLogLines(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
  }
  catch {
    return []
  }
}

/** A file ending in a newline splits into a final empty element; it is not a line. */
function withoutTrailingBlank(lines: string[]): string[] {
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines
}

/**
 * The last `lines` lines across the whole rotation, oldest first.
 *
 * A panel console log keeps one rotation (`.1`), so this reads the current file and `.1` — but a
 * **server's** log is rotated by the panel to `.log.<keep>`, three deep by default, and the two
 * used to share this one implementation. `readLog` therefore printed the newest third of a
 * server's log while the Logs page served all of it. `readRotated` walks the directory instead,
 * which covers one file, two, or eleven.
 *
 * Reads only the tail it needs when it can. The log is capped at 5 MB per file *by rotation*, so a
 * panel that has been up a while keeps a large current file — and the old version read it in full,
 * split every line and threw all but the last fifty away: 24 ms and 28 MB of heap to print fifty
 * lines, on the *default* invocation of a diagnostic command. Most of a tail is not looked at, so
 * it is not read.
 */
export function readLog(file: string, lines: number): string[] {
  return readRotated(file, lines)
}

/**
 * Does this log exist at all — the current file or any rotation of it?
 *
 * Distinct from "has it lines", which is what `readLog` answers: a log the panel opened and has
 * not yet written to is a real log, and a caller deciding "this entry has never run" must not read
 * an empty file as absence. Rotations count on their own because `rotateLog` renames the current
 * file away, so a log that has just rotated has no current file until the next write.
 */
export function logExists(file: string): boolean {
  return rotationFiles(file).length > 0
}

/**
 * The last `lines` lines of one file, as text — read backwards in blocks, stopping as soon as
 * enough line separators have been seen. `''` when there is nothing to contribute, `null` when
 * the file cannot be read at all (which the caller answers by reading everything).
 *
 * The first element may be a fragment: a block boundary lands mid-line. It is deliberately
 * left in place. The loop only exits once `lines + 1` separators are present, so at least
 * `lines` complete lines follow the fragment and the caller's `slice(-lines)` can never reach
 * it — trimming it would be code no test could make fail, and a randomised comparison against
 * the previous implementation confirmed removing it changes nothing.
 */
function readTail(file: string, lines: number): string | null {
  let handle: number
  try {
    handle = fs.openSync(file, 'r')
  }
  catch {
    // Not there is not the same as empty, but both mean "nothing to contribute".
    return ''
  }

  try {
    const size = fs.fstatSync(handle).size
    if (size === 0)
      return ''
    const block = 64 * 1024
    let end = size
    let text = ''

    // `lines + 1` separators, because a file's own trailing newline terminates no line.
    while (end > 0 && countNewlines(text) < lines + 1) {
      const start = Math.max(0, end - block)
      const length = end - start
      const buffer = Buffer.alloc(length)
      fs.readSync(handle, buffer, 0, length, start)
      text = buffer.toString('utf8') + text
      end = start
    }

    return text
  }
  catch {
    return null
  }
  finally {
    fs.closeSync(handle)
  }
}

/**
 * The last `lines` lines across a server's rotation, or nothing when there is nothing to read.
 *
 * A server's log is rotated by the panel into `<id>.log`, `<id>.log.1` … `<id>.log.<keep>`
 * (`LogFiles.ownedFiles`), and `keep` defaults to **three**. This reader walked the current
 * file and `.1` only, so `logs <id> --lines all` on a panel that had rotated printed the newest
 * third of a log the same panel's Logs page serves whole. Measured on a live panel with a chatty
 * entry: **114 of 258 lines** on disk were printed, and the first line shown was not the first
 * line the log held.
 *
 * The list comes from the directory rather than from arithmetic on `keep`: a rotation numbered
 * above a lowered ceiling still exists until the next prune, and it is still this entry's output.
 */
function readRotated(file: string, lines: number): string[] {
  // Newest first, which is the order the panel lists them in and the order a tail walks.
  const files = rotationFiles(file)
  if (files.length === 0)
    return []

  // Everything, asked for as everything: only `--lines all` pays for this, and it asked to.
  if (lines <= 0)
    return readRotatedAll(files)

  // The whole tail has to come from one window, so the newest files are read until they hold
  // enough lines. Concatenating their *text* is what makes a rotation's unterminated last line
  // and the next file's first line one line, exactly as appending the bytes would — splicing the
  // arrays instead would drop it.
  let text = ''
  for (const candidate of files) {
    const chunk = readTail(candidate, lines + 1)
    // `null` is a file that exists but could not be read, which is answered by reading everything
    // — the same fallback a single unreadable file always had.
    if (chunk === null)
      return readRotatedAll(files)
    text = `${chunk}${text}`
    if (countNewlines(text) >= lines + 1)
      break
  }
  return withoutTrailingBlank(text.split('\n')).slice(-lines)
}

/**
 * The whole of every rotation, oldest first, used for `--lines all` and as the fallback when a
 * bounded read cannot reach the tail.
 */
function readRotatedAll(files: readonly string[]): string[] {
  const parts: string[] = []
  // `files` is newest first; the log reads oldest first.
  for (const candidate of [...files].reverse()) {
    try {
      parts.push(fs.readFileSync(candidate, 'utf8'))
    }
    catch {
      // A missing file is normal: neither the log nor its rotations need exist.
    }
  }
  return withoutTrailingBlank(parts.join('').split('\n'))
}

/**
 * The files one log is spread across, newest first.
 *
 * `<id>.log` plus every `<id>.log.<n>` in the directory, numerically ordered — a plain string
 * sort puts `.10` before `.2`, and `keep` allows up to ten rotations. A directory that cannot be
 * listed falls back to the current file, which is what this reader did before.
 */
function rotationFiles(file: string): string[] {
  const dir = path.dirname(file)
  const base = path.basename(file)
  const prefix = `${base}.`

  let names: string[]
  try {
    names = fs.readdirSync(dir)
  }
  catch {
    return fs.existsSync(file) ? [file] : []
  }

  // `.log.1`, `.log.2`, … ascending — that is newest to oldest.
  const rotated = names
    .filter(name => name.startsWith(prefix))
    .map(name => ({ name, index: Number(name.slice(prefix.length)) }))
    .filter(entry => Number.isInteger(entry.index) && entry.index >= 1)
    .sort((left, right) => left.index - right.index)
    .map(entry => path.join(dir, entry.name))

  return fs.existsSync(file) ? [file, ...rotated] : rotated
}

function countNewlines(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10)
      count += 1
  }
  return count
}

/**
 * Prints the last `lines` of the log, then keeps printing whatever is appended.
 *
 * Polled rather than watched on purpose. `config-watch` documents why: an editor's save
 * replaces the inode, and `fs.watch` is undependable on some filesystems. A foreground
 * command also has to notice the rotation `up` performs, which shows up simply as the file
 * getting *smaller* — and a poll sees that without any special case.
 *
 * Resolves when the caller's signal arrives, so the command exits the way a pager would.
 */
export async function followLog(
  file: string,
  lines: number,
  write: (chunk: string) => void,
  pollMs = 250,
): Promise<void> {
  const initial = readLog(file, lines)
  if (initial.length > 0)
    write(`${initial.join('\n')}\n`)

  let offset = sizeOf(file)
  let stopped = false
  const stop = (): void => {
    stopped = true
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  try {
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, pollMs))
      if (stopped)
        break

      const size = sizeOf(file)
      // Truncated or rotated away: start again from the top of what is there now.
      if (size < offset)
        offset = 0
      if (size === offset)
        continue

      try {
        const handle = fs.openSync(file, 'r')
        try {
          const length = size - offset
          const buffer = Buffer.alloc(length)
          fs.readSync(handle, buffer, 0, length, offset)
          // Written exactly as read. A poll can land mid-line, and printing the fragment is
          // what `tail -f` does — the rest arrives on the next poll and concatenates. What
          // must NOT happen is rewriting the bytes: collapsing a trailing run of newlines
          // (`replace(/\n+$/, '\n')`) silently ate blank lines, because the offset had already
          // advanced past them. A blank line the panel wrote is output the person asked for.
          write(buffer.toString('utf8'))
        }
        finally {
          fs.closeSync(handle)
        }
        offset = size
      }
      catch {
        // The file went away between the stat and the read; the next poll re-checks.
      }
    }
  }
  finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  }
  catch {
    return 0
  }
}
