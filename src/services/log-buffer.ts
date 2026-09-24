import type { Buffer } from 'node:buffer'
import type { LogLine, LogStream } from '#src/shared/contracts'

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
  }

  flush(stream: LogStream): void {
    if (this.pending.length === 0)
      return
    this.emit(stream, this.pending)
    this.pending = ''
  }
}
