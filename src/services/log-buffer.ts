import type { Buffer } from 'node:buffer'
import type { LogLine, LogStream } from '#src/shared/contracts'

/** A partial line past this size is emitted rather than buffered further. */
const MAX_PENDING_CHARS = 64 * 1024

/** Fixed-capacity line buffer; oldest lines are dropped first. */
export class LogBuffer {
  private lines: LogLine[] = []

  constructor(private capacity: number) {}

  push(line: LogLine): void {
    this.lines.push(line)
    if (this.lines.length > this.capacity)
      this.lines.splice(0, this.lines.length - this.capacity)
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
