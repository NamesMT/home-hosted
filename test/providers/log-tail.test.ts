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
})
