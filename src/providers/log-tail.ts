import type { LogLine } from '#src/shared/contracts'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'

/**
 * Reads the JSONL a nanny writes for a persistent entry, from where it last stopped.
 *
 * The panel is not the writer here, so the reader has to survive the two things a
 * writer does on its own: rotation (a renamed file next to a fresh one) and
 * truncation. Both are detected by comparing the file's identity and size against
 * the position last read, and every poll reads to EOF so a rotation never strands
 * bytes in the file it left behind.
 */

/** One poll reads at most this much, so a burst cannot stall the tick. */
const MAX_BYTES_PER_READ = 256 * 1024

/**
 * The window a backfill starts with, and the ceiling it may grow to.
 *
 * It has to grow because the request is in *lines* and the window is in *bytes*: a
 * persistent entry's JSONL carries whatever its server printed, so one line can be a stack
 * trace. A fixed 256 KB window returned 178 of the 200 lines asked for at ~1500-byte lines,
 * and the oldest line handed back was not the oldest asked for. The ceiling keeps a bounded
 * request bounded — a log of nothing but megabyte lines stops growing rather than being read
 * whole.
 */
const BACKFILL_INITIAL_BYTES = 256 * 1024
const BACKFILL_MAX_BYTES = 8 * 1024 * 1024

/** A partial line longer than this is dropped rather than buffered without bound. */
const MAX_CARRY_CHARS = 1024 * 1024

const LOG_STREAMS = new Set(['stdout', 'stderr', 'system'])

export class LogTailer {
  private offset = 0
  private identity: number | null = null
  private carry = ''

  constructor(private readonly file: string) {}

  /** Bytes consumed so far; equal to the file size once it has been drained. */
  get position(): number {
    return this.offset
  }

  /** Start from the beginning again — used when a fresh process takes the entry over. */
  reset(): void {
    this.offset = 0
    this.identity = null
    this.carry = ''
  }

  /**
   * The last `count` lines, with the read position moved to the end of the file in the
   * same operation.
   *
   * A panel attaching to a running entry wants both a backfill and a live stream, and
   * only one thing may own the offset. Reading the tail through the same tailer is what
   * keeps a line from being replayed as news or skipped as history — and it is why this
   * does not delegate to `LogFiles.readTail()`, which knows nothing of this position.
   */
  readTailLines(count: number): LogLine[] {
    let stats: fs.Stats
    try {
      stats = fs.statSync(this.file)
    }
    catch {
      return []
    }

    const size = stats.size
    this.carry = ''
    this.offset = size
    this.identity = stats.ino === 0 ? stats.birthtimeMs : stats.ino
    if (size === 0 || count <= 0)
      return []

    let handle: number
    try {
      handle = fs.openSync(this.file, 'r')
    }
    catch {
      return []
    }

    try {
      let window = Math.min(size, BACKFILL_INITIAL_BYTES)
      for (;;) {
        const start = size - window
        const buffer = Buffer.alloc(window)
        const bytes = fs.readSync(handle, buffer, 0, buffer.length, start)
        const raw = buffer.subarray(0, bytes).toString('utf8').split('\n')
        // A read that starts mid-file begins on a partial line — but only when the byte
        // before `start` is not the newline that ended the previous one. Dropping the
        // first element unconditionally lost one complete line per attach once the log
        // passed the tail window, and filtering *before* the drop made a blank leading
        // fragment drop a real line as well.
        let partialStart = false
        if (start > 0) {
          const previous = Buffer.alloc(1)
          const readBack = fs.readSync(handle, previous, 0, 1, start - 1)
          partialStart = readBack === 1 && previous[0] !== 0x0A
        }
        const lines = (partialStart ? raw.slice(1) : raw).filter(line => line.trim().length > 0)

        // Enough for the request, the whole file, or the ceiling: stop. Otherwise the window
        // was too small for lines this long, so read more rather than returning short.
        const grew = window < size && window < BACKFILL_MAX_BYTES
        if (lines.length >= count || !grew) {
          return lines.slice(-count)
            .map(parseLogLine)
            .filter((line): line is LogLine => line !== null)
        }

        window = Math.min(size, window * 4)
      }
    }
    catch {
      return []
    }
    finally {
      fs.closeSync(handle)
    }
  }

  /**
   * Ignore what is already in the file and follow it from here.
   */
  skipToEnd(): void {
    this.carry = ''
    try {
      const stats = fs.statSync(this.file)
      this.offset = stats.size
      this.identity = stats.ino === 0 ? stats.birthtimeMs : stats.ino
    }
    catch {
      this.offset = 0
      this.identity = null
    }
  }

  /** Every complete line written since the previous call. */
  read(): LogLine[] {
    let stats: fs.Stats
    try {
      stats = fs.statSync(this.file)
    }
    catch {
      // Not created yet, or rotated away between the two syscalls.
      return []
    }

    // `ino` is 0 on some Windows filesystems; the birth time identifies the file there.
    const identity = stats.ino === 0 ? stats.birthtimeMs : stats.ino
    if (this.identity !== null && (identity !== this.identity || stats.size < this.offset)) {
      this.carry = ''
      this.offset = 0
    }
    this.identity = identity

    if (stats.size <= this.offset)
      return []

    const lines: LogLine[] = []
    let handle: number
    try {
      handle = fs.openSync(this.file, 'r')
    }
    catch {
      return []
    }

    try {
      // A poll consumes at most `MAX_BYTES_PER_READ`, which is what the constant promises. Sizing the
      // buffer is not enough: refilling it in a loop until EOF drained a whole backlog in one
      // synchronous call, and `LogRelay` calls this every 250 ms — so a server flooding its log while
      // the panel was busy stalled the event loop for the entire catch-up. The remainder waits for the
      // next poll, which is 250 ms away.
      const budget = Math.min(MAX_BYTES_PER_READ, stats.size - this.offset)
      const buffer = Buffer.alloc(budget)
      let consumed = 0
      while (consumed < budget && this.offset < stats.size) {
        const length = Math.min(buffer.length, budget - consumed, stats.size - this.offset)
        const bytes = fs.readSync(handle, buffer, 0, length, this.offset)
        if (bytes <= 0)
          break
        this.offset += bytes
        consumed += bytes
        this.consume(buffer.subarray(0, bytes).toString('utf8'), lines)
        if (bytes < length)
          break
      }
    }
    catch {
      // A file replaced mid-read is picked up by the next poll.
    }
    finally {
      fs.closeSync(handle)
    }

    return lines
  }

  private consume(text: string, lines: LogLine[]): void {
    if (this.carry.length === 0) {
      this.carry = text
    }
    else {
      this.carry += text
    }

    const parts = this.carry.split('\n')
    // The last part has no newline yet: it is a write we have half seen.
    this.carry = parts.pop() ?? ''

    for (const part of parts) {
      if (part.trim().length === 0)
        continue
      const line = parseLogLine(part)
      if (line !== null)
        lines.push(line)
    }

    if (this.carry.length > MAX_CARRY_CHARS)
      this.carry = ''
  }
}

/**
 * Cheap structural guard rather than a full schema pass: this runs per line on a hot
 * path, and the writer is our own nanny (which serializes `LogLine` unchanged).
 */
function parseLogLine(raw: string): LogLine | null {
  try {
    const value = JSON.parse(raw) as Partial<LogLine>
    if (typeof value.ts !== 'number' || typeof value.text !== 'string' || typeof value.stream !== 'string')
      return null
    if (!LOG_STREAMS.has(value.stream))
      return null
    return { ts: value.ts, stream: value.stream as LogLine['stream'], text: value.text }
  }
  catch {
    // A partial line from a rotation boundary.
    return null
  }
}
