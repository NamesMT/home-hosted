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
 */
export function readLog(file: string, lines: number): string[] {
  const parts: string[] = []
  for (const candidate of [`${file}.1`, file]) {
    try {
      parts.push(fs.readFileSync(candidate, 'utf8'))
    }
    catch {
      // A missing file is normal: neither the log nor its rotation need exist.
    }
  }
  const all = withoutTrailingBlank(parts.join('').split('\n'))
  return lines > 0 ? all.slice(-lines) : all
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
