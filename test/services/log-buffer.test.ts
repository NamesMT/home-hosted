import type { LogLine, LogStream } from '#src/shared/contracts'
import { describe, expect, it } from 'vitest'
import { LineSplitter, LogBuffer } from '#src/services/log-buffer'

function line(text: string): LogLine {
  return { ts: 1, stream: 'stdout', text }
}

describe('logBuffer', () => {
  it('keeps only the newest lines once at capacity', () => {
    const buffer = new LogBuffer(3)
    buffer.extend([line('a'), line('b'), line('c'), line('d')])
    expect(buffer.list().map(entry => entry.text)).toEqual(['b', 'c', 'd'])
    expect(buffer.size).toBe(3)
  })

  /**
   * The line count is the user's setting; it must not double as a memory budget.
   *
   * A line is capped at 64 KiB by the splitter, so `logBufferLines: 500` of a chatty writer is
   * ~32 MB of heap per server, held forever. The panel climbed from 284 MB to 601 MB with 2 MB
   * lines in the operator audit. The ring now also caps total characters.
   */
  it('drops the oldest lines past its total-size ceiling, not only past its line count', () => {
    const buffer = new LogBuffer(500)
    const chunk = 'x'.repeat(60 * 1024)
    // Well under the 500-line capacity, and far over the ceiling.
    for (let index = 0; index < 200; index += 1)
      buffer.push({ ts: index, stream: 'stdout', text: `${index}:${chunk}` })

    const held = buffer.size
    expect(held).toBeLessThan(200)
    expect(held).toBeGreaterThan(1)
    // The newest line always survives: a ceiling must never leave the panel with nothing to show.
    expect(buffer.list(1)[0]?.text.startsWith('199:')).toBe(true)
  })

  it('still honours the line count when lines are small', () => {
    const buffer = new LogBuffer(3)
    for (let index = 0; index < 10; index += 1)
      buffer.push({ ts: index, stream: 'stdout', text: `line-${index}` })

    expect(buffer.size).toBe(3)
    expect(buffer.list().map(line => line.text)).toEqual(['line-7', 'line-8', 'line-9'])
  })

  it('returns a copy so callers cannot mutate the ring', () => {
    const buffer = new LogBuffer(2)
    buffer.push(line('a'))
    const listed = buffer.list()
    listed.push(line('b'))
    expect(buffer.size).toBe(1)
  })

  it('limits from the tail', () => {
    const buffer = new LogBuffer(10)
    buffer.extend([line('a'), line('b'), line('c')])
    expect(buffer.list(2).map(entry => entry.text)).toEqual(['b', 'c'])
  })

  it('clears', () => {
    const buffer = new LogBuffer(5)
    buffer.push(line('a'))
    buffer.clear()
    expect(buffer.list()).toEqual([])
  })
})

describe('lineSplitter', () => {
  it('emits complete lines only, buffering the trailing partial one', () => {
    const seen: Array<[LogStream, string]> = []
    const splitter = new LineSplitter((stream, text) => seen.push([stream, text]))

    splitter.push('stdout', 'hel')
    expect(seen).toEqual([])

    splitter.push('stdout', 'lo\nworld\n')
    expect(seen).toEqual([['stdout', 'hello'], ['stdout', 'world']])
  })

  it('strips carriage returns from CRLF output', () => {
    const seen: string[] = []
    const splitter = new LineSplitter((_stream, text) => seen.push(text))
    splitter.push('stdout', 'a\r\nb\r\n')
    expect(seen).toEqual(['a', 'b'])
  })

  it('flushes an unterminated final line', () => {
    const seen: string[] = []
    const splitter = new LineSplitter((_stream, text) => seen.push(text))
    splitter.push('stderr', 'partial')
    splitter.flush('stderr')
    expect(seen).toEqual(['partial'])
    splitter.flush('stderr')
    expect(seen).toEqual(['partial'])
  })

  it('emits an oversized partial line instead of buffering it forever', () => {
    const seen: string[] = []
    const splitter = new LineSplitter((_stream, text) => seen.push(text))
    const huge = 'x'.repeat(200 * 1024)

    splitter.push('stdout', huge)

    // Nothing is lost, but no piece is left growing in memory: a child that never
    // sends a newline (a progress bar, one minified JSON blob) cannot OOM the daemon.
    expect(huge.startsWith(seen.join(''))).toBe(true)
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.every(text => text.length <= 64 * 1024)).toBe(true)

    // What is left buffered is the tail of that same line, not a copy.
    splitter.flush('stdout')
    expect(seen.join('')).toBe(huge)
  })

  it('strips the carriage return of a flushed partial line too', () => {
    const seen: string[] = []
    const splitter = new LineSplitter((_stream, text) => seen.push(text))
    splitter.push('stdout', 'done\r')
    splitter.flush('stdout')
    expect(seen).toEqual(['done'])
  })
})
