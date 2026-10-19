import type { Buffer } from 'node:buffer'
import type { LogLine, LogStream } from '#src/shared/contracts'

/** A partial line past this size is emitted rather than buffered further. */
const MAX_PENDING_CHARS = 64 * 1024

/**
 * How many *characters* the ring may hold, on top of its line count.
 *
 * `logBufferLines` bounds lines, and a line is capped at 64 KiB by the splitter — so 500 lines
 * of a chatty 2 MB/s writer is ~32 MB per server, times every server, in the panel's heap. The
 * count is the user's setting; this is the ceiling that keeps that setting from being a memory
 * bomb. Generous enough that ordinary logs never reach it (500 lines is well under 1 MB).
 */
const MAX_TOTAL_CHARS = 4 * 1024 * 1024

/** Fixed-capacity line buffer; oldest lines are dropped first. */
export class LogBuffer {
  private lines: LogLine[] = []
  /** Characters held, so the byte ceiling never needs a rescan. */
  private chars = 0

  constructor(private capacity: number) {}

  push(line: LogLine): void {
    this.lines.push(line)
    this.chars += line.text.length
    if (this.lines.length > this.capacity)
      this.dropOldest(this.lines.length - this.capacity)
    // Drop past the ceiling too, keeping at least one line so a single oversized line is still
    // shown rather than leaving the buffer empty.
    while (this.chars > MAX_TOTAL_CHARS && this.lines.length > 1)
      this.dropOldest(1)
  }

  /** Removes the oldest `count` lines and keeps `chars` in step with them. */
  private dropOldest(count: number): void {
    const dropped = this.lines.splice(0, count)
    for (const line of dropped) this.chars -= line.text.length
  }

  extend(lines: LogLine[]): void {
    for (const line of lines) this.push(line)
  }

  list(limit?: number): LogLine[] {
    if (limit === undefined || limit >= this.lines.length)
      return [...this.lines]
    return this.lines.slice(-limit)
  }

  clear(): void {
    this.lines = []
    this.chars = 0
  }

  get size(): number {
    return this.lines.length
  }
}

/**
 * Splits a chunk into complete lines, keeping a trailing partial line buffered:
 * a child writing "hel" then "lo\n" must surface one line, not two.
 */
export class LineSplitter {
  private pending = ''

  constructor(private readonly emit: (stream: LogStream, text: string) => void) {}

  push(stream: LogStream, chunk: string | Buffer): void {
    this.pending += chunk.toString()
    const parts = this.pending.split('\n')
    this.pending = parts.pop() ?? ''
    for (const part of parts) this.emit(stream, part.replace(/\r$/, ''))
    // A child that never sends a newline (a progress bar, one minified JSON blob)
    // must not grow this string without bound: past the cap it is emitted in pieces.
    while (this.pending.length > MAX_PENDING_CHARS) {
      this.emit(stream, this.pending.slice(0, MAX_PENDING_CHARS))
      this.pending = this.pending.slice(MAX_PENDING_CHARS)
    }
  }

  flush(stream: LogStream): void {
    if (this.pending.length === 0)
      return
    this.emit(stream, this.pending.replace(/\r$/, ''))
    this.pending = ''
  }
}
