import { Buffer } from 'node:buffer'
import fs from 'node:fs'
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
 * One rotation boundary's worth of lines, oldest first.
 *
 * The current file plus its `.1` ancestor, so `logs` shows what happened just before a
 * rotation rather than starting blank. `lines <= 0` means the whole thing.
 *
 * Reads only the tail it needs. The log is capped at 5 MB per file *by rotation*, so a panel
 * that has been up a while keeps a 5 MB current file plus a 5 MB `.1` — and the old version
 * read both in full, split every line and threw all but the last fifty away: 24 ms and 28 MB
 * of heap to print fifty lines, on the *default* invocation of a diagnostic command. Most of
 * a tail is not looked at, so it is not read.
 */
export function readLog(file: string, lines: number): string[] {
  // The whole log, oldest first. Only `--lines all` pays for this, and it asked to.
  if (lines <= 0) {
    const parts = readBoth(file)
    return withoutTrailingBlank(parts.join('').split('\n'))
  }

  // The same answer as reading both files and taking the tail of the split, without reading
  // either in full: the current file alone supplies the tail unless it is too short, in which
  // case `.1` supplies the rest.
  const tail = tailText(file, lines)
  if (tail === null) {
    const parts = readBoth(file)
    return withoutTrailingBlank(parts.join('').split('\n')).slice(-lines)
  }
  return withoutTrailingBlank(tail.split('\n')).slice(-lines)
}

/** Both sides of the rotation, oldest first. Missing files contribute nothing. */
function readBoth(file: string): string[] {
  const parts: string[] = []
  for (const candidate of [`${file}.1`, file]) {
    try {
      parts.push(fs.readFileSync(candidate, 'utf8'))
    }
    catch {
      // A missing file is normal: neither the log nor its rotation need exist.
    }
  }
  return parts
}

/**
 * The text of the last `lines` lines across the rotation, joined the way concatenating the
 * two files would join it — or `null` when the tail cannot be reached within the block budget,
 * in which case the caller reads everything.
 *
 * Concatenating `.1` and the current file makes `.1`'s unterminated last line and the current
 * file's first line *one* line. Keeping the two tails as text and joining them reproduces that
 * for free: no gluing to arrange, and no line to lose. (An earlier draft spliced the arrays
 * instead and dropped that line.)
 */
function tailText(file: string, lines: number): string | null {
  // One more than asked, because a file's own trailing newline terminates no line.
  const wanted = lines + 1
  const current = readTail(file, wanted)
  if (current === null)
    return null
  if (countNewlines(current) >= wanted)
    return current

  // The current file is short of the tail, so reach into the rotation — and enough of it that
  // a partial line at its end is included, since that is the one that merges.
  const rotated = readTail(`${file}.1`, wanted)
  if (rotated === null)
    return null
  return `${rotated}${current}`
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
 * The last `lines` lines of one file, without reading the whole of it.
 *
 * Reads backwards in blocks and stops as soon as it has enough newlines. A single line can
 * still be long, so the block grows rather than the read being capped at the exact byte.
 */

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
