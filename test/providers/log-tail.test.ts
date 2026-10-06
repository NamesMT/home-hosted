import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LogTailer } from '#src/providers/log-tail'

/**
 * The tailer reads a file another process owns, so the cases that matter are the ones
 * that process can create on its own: a half-written line, a rotation, a truncation.
 */

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempFile(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-tail-'))
  cleanups.push(() => fs.promises.rm(dir, { recursive: true, force: true }))
  return path.join(dir, 'x.log')
}

function line(text: string, stream = 'stdout'): string {
  return `${JSON.stringify({ ts: 1, stream, text })}\n`
}

describe('logTailer', () => {
  it('returns only complete lines, and completes a half-written one on the next read', async () => {
    const file = await tempFile()
    const tailer = new LogTailer(file)

    fs.writeFileSync(file, line('one'))
    expect(tailer.read().map(entry => entry.text)).toEqual(['one'])

    // A writer caught mid-line: the bytes are consumed, but not emitted as a line.
    fs.appendFileSync(file, '{"ts":1,"stream":"stdout","text":"tw')
    expect(tailer.read()).toEqual([])

    fs.appendFileSync(file, 'o"}\n')
    expect(tailer.read().map(entry => entry.text)).toEqual(['two'])
  })

  it('follows a rotation into the new file without losing the old tail', async () => {
    const file = await tempFile()
    const tailer = new LogTailer(file)

    fs.writeFileSync(file, line('before'))
    expect(tailer.read().map(entry => entry.text)).toEqual(['before'])

    fs.renameSync(file, `${file}.1`)
    fs.writeFileSync(file, line('after'))
    expect(tailer.read().map(entry => entry.text)).toEqual(['after'])
  })

  it('starts over when the file is truncated under it', async () => {
    const file = await tempFile()
    const tailer = new LogTailer(file)

    fs.writeFileSync(file, line('gone-away'))
    expect(tailer.read().map(entry => entry.text)).toEqual(['gone-away'])

    fs.writeFileSync(file, line('kept'))
    expect(tailer.read().map(entry => entry.text)).toEqual(['kept'])
  })

  it('skips to the end, so hour-old output is not replayed as news', async () => {
    const file = await tempFile()
    fs.writeFileSync(file, line('old'))

    const tailer = new LogTailer(file)
    tailer.skipToEnd()
    expect(tailer.read()).toEqual([])

    fs.appendFileSync(file, line('new'))
    expect(tailer.read().map(entry => entry.text)).toEqual(['new'])
  })

  it('reads a backfill and moves past it in the same step, so nothing is replayed', async () => {
    const file = await tempFile()
    fs.writeFileSync(file, line('one') + line('two') + line('three'))

    const tailer = new LogTailer(file)
    expect(tailer.readTailLines(2).map(entry => entry.text)).toEqual(['two', 'three'])
    // The offset moved with the backfill: those two are history, not news.
    expect(tailer.read()).toEqual([])

    fs.appendFileSync(file, line('four'))
    expect(tailer.read().map(entry => entry.text)).toEqual(['four'])
  })

  it('ignores a file that is not there yet, and a line that is not ours', async () => {
    const file = await tempFile()
    const tailer = new LogTailer(file)
    expect(tailer.read()).toEqual([])

    fs.writeFileSync(file, `not json\n${line('fine', 'stderr')}`)
    const lines = tailer.read()
    expect(lines).toHaveLength(1)
    expect(lines[0]!.stream).toBe('stderr')
  })

  it('keeps every line asked for when a window starts on a line boundary', async () => {
    // Five lines of exactly 65536 bytes each. The reader starts with a 256 KiB window, whose
    // offset is exactly the first byte of line 2, so no partial line is cut and `slice(1)`
    // must not drop a complete one — the bug this test was written for.
    //
    // It used to expect four lines, because four was all a fixed 256 KiB window held. That was
    // the truncation asserting itself: the request is for five. The window now grows until it
    // has them, so the answer is all five — and the first is still not lost to the boundary.
    const file = await tempFile()
    const tailer = new LogTailer(file)
    const exactLine = (marker: string, bytes: number): string => {
      const empty = `${JSON.stringify({ ts: 1, stream: 'stdout', text: marker })}\n`
      const pad = bytes - Buffer.byteLength(empty)
      return `${JSON.stringify({ ts: 1, stream: 'stdout', text: marker + 'x'.repeat(pad) })}\n`
    }
    const body = ['one', 'two', 'three', 'four', 'five'].map(marker => exactLine(marker, 65_536)).join('')
    expect(Buffer.byteLength(body)).toBe(5 * 65_536)
    fs.writeFileSync(file, body)

    const backfill = tailer.readTailLines(5)
    expect(backfill.map(entry => entry.text.trimEnd().replace(/x+$/, ''))).toEqual(['one', 'two', 'three', 'four', 'five'])
    // The offset still moved to EOF: the backfill is history, not news.
    expect(tailer.read()).toEqual([])
  })

  it('does not lose a real line to a blank leading fragment', async () => {
    // The window starts inside a whitespace-only line, so the fragment filters out as
    // blank — and then `slice(1)` removed the first *real* line behind it. Filtering
    // has to happen after the fragment is dropped, not before.
    const file = await tempFile()
    const tailer = new LogTailer(file)
    fs.writeFileSync(file, `${' '.repeat(300_000)}\n${line('one')}${line('two')}`)

    const backfill = tailer.readTailLines(10)
    expect(backfill.map(entry => entry.text)).toEqual(['one', 'two'])
  })
})

/**
 * The request is in lines; the window was in bytes.
 *
 * A persistent entry's JSONL carries whatever its server printed, so a line can be a stack
 * trace. With a fixed 256 KiB window, ~1500-byte lines gave 178 of the 200 lines asked for,
 * and the oldest line handed back was not the oldest asked for — so a panel reattaching to a
 * running entry silently showed a shorter history than the entry's own logs held.
 */
describe('a backfill with long lines', () => {
  it('returns every line asked for, oldest first', async () => {
    const file = await tempFile()
    const tailer = new LogTailer(file)
    const body = Array.from({ length: 2000 }, (_, i) =>
      `${JSON.stringify({ ts: 1_700_000_000_000 + i, stream: 'stdout', text: `long output ${i} ${'x'.repeat(1400)}` })}\n`).join('')
    fs.writeFileSync(file, body)

    const backfill = tailer.readTailLines(200)
    expect(backfill).toHaveLength(200)
    // The oldest is the 200th from the end, not an arbitrary later one.
    expect(backfill[0]!.ts).toBe(1_700_000_000_000 + 1800)
    expect(backfill.at(-1)!.ts).toBe(1_700_000_000_000 + 1999)
  })

  it('still returns everything a short log holds, without inventing lines', async () => {
    const file = await tempFile()
    const tailer = new LogTailer(file)
    fs.writeFileSync(file, `${JSON.stringify({ ts: 1, stream: 'stdout', text: 'only' })}\n`)

    expect(tailer.readTailLines(200)).toHaveLength(1)
  })
})

/**
 * One `read()` must not drain an unbounded backlog.
 *
 * `MAX_BYTES_PER_READ` is documented as "one poll reads at most this much, so a burst cannot stall
 * the tick" — but the buffer it sizes is *refilled in a loop until EOF*, so the constant bounded the
 * allocation and not the bytes read. `LogRelay` calls `read()` every 250 ms, and the read is
 * synchronous, so a server that floods its log while the panel is busy stalls the event loop for the
 * whole catch-up.
 *
 * The test measures the number of bytes each read can hand back rather than asserting on internals:
 * a backlog several times the constant must leave work for the next poll.
 */
describe('log tailer read bound', () => {
  it('leaves a large backlog for later polls instead of draining it in one', async () => {
    const file = await tempFile()
    // 2 MB of well-formed lines: eight times MAX_BYTES_PER_READ (256 KB).
    const line = `${JSON.stringify({ stream: 'stdout', text: 'x'.repeat(120), ts: 1 })}\n`
    const total = 2 * 1024 * 1024
    const content = line.repeat(Math.ceil(total / line.length))
    await fs.promises.writeFile(file, content)

    const tailer = new LogTailer(file)
    const first = tailer.read()

    expect(first.length, 'a first read must return lines').toBeGreaterThan(0)
    // The bound, expressed in the units the comment uses: bytes consumed, not buffer size.
    const consumed = tailer.position
    expect(consumed, `one read consumed ${consumed} bytes`).toBeLessThanOrEqual(256 * 1024)

    // And the rest is still there for the next poll, rather than lost.
    const second = tailer.read()
    expect(second.length).toBeGreaterThan(0)
    expect(tailer.position).toBeGreaterThan(consumed)
  })
})
