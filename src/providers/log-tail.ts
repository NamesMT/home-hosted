import type { LogLine } from '#src/shared/contracts'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import { Utf8Chunks } from '#src/helpers/utf8-chunks'

/**
 * Reads the JSONL a nanny writes for a persistent entry, from where it last stopped.
 *
 * The panel is not the writer here, so the reader has to survive the two things a
 * writer does on its own: rotation (a renamed file next to a fresh one) and
 * truncation. The tailer holds the file it is reading open, so a rotation renames
 * that file away from under the path but not from under the tailer: the old file is
 * drained to EOF through its descriptor before the new one is opened, and the bytes
 * written between the last poll and the rename are still relayed.
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

/** `ino` is 0 on some Windows filesystems; the birth time identifies the file there. */
function identityOf(stats: fs.Stats): number {
  return stats.ino === 0 ? stats.birthtimeMs : stats.ino
}

export class LogTailer {
  private offset = 0
  private identity: number | null = null
  /** The file being read, held open so a rotation cannot take its unread tail away. */
  private fd: number | null = null
  private carry = ''
  /** The file is one byte stream: a read budget can end inside a multibyte character. */
  private readonly decoder = new Utf8Chunks()

  constructor(private readonly file: string) {}

  /** Bytes consumed so far; equal to the file size once it has been drained. */
  get position(): number {
    return this.offset
  }

  /** Start from the beginning again — used when a fresh process takes the entry over. */
  reset(): void {
    this.close()
    this.offset = 0
    this.identity = null
    this.dropCarry()
  }

  /** Releases the descriptor. A later `read()` reopens the path. */
  close(): void {
    if (this.fd === null)
      return
    try {
      fs.closeSync(this.fd)
    }
    catch {
      // Already closed.
    }
    this.fd = null
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
    const size = this.attachAtEnd()
    if (this.fd === null || size === 0 || count <= 0)
      return []
    const handle = this.fd

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
  }

  /**
   * Ignore what is already in the file and follow it from here.
   */
  skipToEnd(): void {
    this.attachAtEnd()
  }

  /** Every complete line written since the previous call. */
  read(): LogLine[] {
    const lines: LogLine[] = []
    if (this.fd === null && !this.openPath())
      return lines

    // A poll consumes at most `MAX_BYTES_PER_READ`, which is what the constant promises: `LogRelay`
    // calls this every 250 ms, and draining a whole backlog in one synchronous call stalled the
    // event loop for the entire catch-up. The remainder waits for the next poll.
    let budget = MAX_BYTES_PER_READ
    try {
      budget -= this.drain(budget, lines)

      // The path names another file now: the writer rotated. Only once the old one is read to its
      // end — the writer has moved on, so that end is final — does the tailer switch to the new one.
      if (this.fd !== null && this.pathReplaced() && this.drained() && this.openPath(true))
        this.drain(budget, lines)
    }
    catch {
      // A file replaced mid-read is picked up by the next poll.
    }

    return lines
  }

  /** Opens the path and moves to its end, dropping anything held from an earlier file. */
  private attachAtEnd(): number {
    this.close()
    this.dropCarry()
    this.offset = 0
    this.identity = null
    if (!this.openPath())
      return 0
    try {
      this.offset = fs.fstatSync(this.fd!).size
    }
    catch {
      this.close()
    }
    return this.offset
  }

  /**
   * Opens whatever the path names now. A file other than the one last read starts at 0;
   * reopening the same one (after `close()`) keeps the position. `replaced` says the caller
   * already knows it is another file, whatever its identity reads.
   */
  private openPath(replaced = false): boolean {
    let fd: number
    try {
      fd = fs.openSync(this.file, 'r')
    }
    catch {
      // Not created yet, or between a rename and the next write.
      return false
    }
    let identity: number
    try {
      identity = identityOf(fs.fstatSync(fd))
    }
    catch {
      fs.closeSync(fd)
      return false
    }
    this.close()
    if (replaced || (this.identity !== null && identity !== this.identity)) {
      this.offset = 0
      this.dropCarry()
    }
    this.identity = identity
    this.fd = fd
    return true
  }

  /**
   * Whether the path now names a different file than the open descriptor — or none.
   *
   * Identity alone is not trusted: where `ino` is 0 the birth time stands in for it and can
   * collide, so a path *smaller* than the open file (stat'd after it, so a same-file reading can
   * only be larger) is a different file too.
   */
  private pathReplaced(): boolean {
    const held = fs.fstatSync(this.fd!)
    let current: fs.Stats
    try {
      current = fs.statSync(this.file)
    }
    catch {
      return true
    }
    return identityOf(current) !== identityOf(held) || current.size < held.size
  }

  private drained(): boolean {
    return this.offset >= fs.fstatSync(this.fd!).size
  }

  /** Reads the open file from `offset` towards its end, up to `budget` bytes; returns bytes read. */
  private drain(budget: number, lines: LogLine[]): number {
    const fd = this.fd!
    const size = fs.fstatSync(fd).size
    if (size < this.offset) {
      // Truncated in place: start over on the same file.
      this.offset = 0
      this.dropCarry()
    }
    const want = Math.min(budget, size - this.offset)
    if (want <= 0)
      return 0

    const buffer = Buffer.alloc(want)
    let consumed = 0
    while (consumed < want) {
      const bytes = fs.readSync(fd, buffer, 0, want - consumed, this.offset)
      if (bytes <= 0)
        break
      this.offset += bytes
      consumed += bytes
      this.consume(this.decoder.write(buffer.subarray(0, bytes)), lines)
    }
    return consumed
  }

  /** Forget a half-seen line (and character): the bytes that would complete it are gone. */
  private dropCarry(): void {
    this.carry = ''
    this.decoder.reset()
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
