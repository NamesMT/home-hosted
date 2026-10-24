import type { LogLine, LogsConfig } from '#src/shared/contracts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type } from 'arktype'
import { afterEach, describe, expect, it } from 'vitest'
import { LogFiles } from '#src/services/log-files'
import { logsSchema } from '#src/shared/contracts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function makeLogs(overrides: Partial<LogsConfig> = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-logs-'))
  dirs.push(dir)

  const parsed = logsSchema({ ...overrides })
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)

  const files = new LogFiles(path.join(dir, 'logs'), () => parsed)
  return { files, dir }
}

function line(text: string, stream: LogLine['stream'] = 'stdout'): LogLine {
  return { ts: 1700000000000, stream, text }
}

describe('log files', () => {
  it('appends and tails what was written', async () => {
    const { files } = await makeLogs()
    files.append('web', line('first'))
    files.append('web', line('second', 'stderr'))
    files.flush()

    const lines = files.readTail('web', 10)
    expect(lines.map(entry => entry.text)).toEqual(['first', 'second'])
    expect(lines[1]?.stream).toBe('stderr')
  })

  it('keeps servers in separate files', async () => {
    const { files } = await makeLogs()
    files.append('a', line('from a'))
    files.append('b', line('from b'))
    files.flush()

    expect(files.readTail('a', 10).map(entry => entry.text)).toEqual(['from a'])
    expect(files.readTail('b', 10).map(entry => entry.text)).toEqual(['from b'])
  })

  it('only returns the requested tail', async () => {
    const { files } = await makeLogs()
    for (let index = 0; index < 20; index++) files.append('web', line(`line ${index}`))
    files.flush()

    const lines = files.readTail('web', 5)
    expect(lines.map(entry => entry.text)).toEqual(['line 15', 'line 16', 'line 17', 'line 18', 'line 19'])
  })

  it('does not write anything when persistence is off', async () => {
    const { files } = await makeLogs({ persist: false })
    files.append('web', line('ignored'))
    files.flush()

    expect(files.readTail('web', 10)).toEqual([])
    expect(files.info('web').enabled).toBe(false)
  })

  it('rotates once the file passes maxBytes and keeps the history readable', async () => {
    const { files } = await makeLogs({ maxBytes: 10000, keep: 2 })

    for (let index = 0; index < 200; index++) {
      files.append('web', line(`line ${index} ${'x'.repeat(80)}`))
    }
    files.flush()

    const info = files.info('web')
    expect(info.files.length).toBeGreaterThan(1)
    expect(info.files.some(file => file.name === 'web.log.1')).toBe(true)

    // The tail spans the rotation boundary.
    const lines = files.readTail('web', 10)
    expect(lines.map(entry => entry.text)).toContain(`line 199 ${'x'.repeat(80)}`)
    expect(lines.length).toBe(10)
  })

  it('reports the disk size and clears on demand', async () => {
    const { files } = await makeLogs()
    files.append('web', line('something'))
    files.flush()

    expect(files.info('web').sizeBytes).toBeGreaterThan(0)
    files.clear('web')
    expect(files.info('web').sizeBytes).toBe(0)
    expect(files.readTail('web', 5)).toEqual([])
  })

  it('clears lines that are still pending, not only the bytes already on disk', async () => {
    // `clear` removed the files but left the unflushed batch alone, and `flush()` writes that batch
    // out — so the lines a delete was meant to remove reappeared a moment later (or on `dispose`,
    // after the timer was cleared). The test above flushes first, so it cannot see this.
    const { files } = await makeLogs()
    files.append('web', line('LINE THE USER ASKED TO DELETE'))
    files.clear('web')
    files.flush()

    expect(files.readTail('web', 5), 'a cleared line must not come back on the next flush').toEqual([])
  })

  it('flushes pending lines on dispose', async () => {
    const { files, dir } = await makeLogs()
    files.append('web', line('written on dispose'))
    files.dispose()

    const written = await fs.promises.readFile(path.join(dir, 'logs', 'web.log'), 'utf8')
    expect(written).toContain('written on dispose')
  })
})

/**
 * A tail larger than one read chunk, which used to be silently truncated.
 *
 * The reader opened the file once, took a single fixed 256 KB window and stopped. A JSONL line
 * here runs a couple of hundred bytes, so that window holds roughly 1500 of them — while the
 * route accepts `tail=5000`. Asking for 5000 returned 1464 and dropped 3536 lines with no
 * error, and the oldest line handed back was not the one asked for.
 */
describe('a tail larger than one read chunk', () => {
  const jsonLine = (i: number): string =>
    JSON.stringify({ ts: 1_700_000_000_000 + i, stream: 'stdout', text: `line ${i} ${'x'.repeat(120)}` })

  it('returns every line asked for, oldest first, when the window must grow', async () => {
    const { files, dir } = await makeLogs()
    // ~890 KB, comfortably past the 256 KB window once.
    const total = 5000
    await fs.promises.mkdir(path.join(dir, 'logs'), { recursive: true })
    await fs.promises.writeFile(
      path.join(dir, 'logs', 'web.log'),
      `${Array.from({ length: total }, (_, i) => jsonLine(i)).join('\n')}\n`,
    )

    const tail = files.readTail('web', total)
    expect(tail).toHaveLength(total)
    // The oldest line is the one at index 0 — the truncation showed up here first.
    expect(tail[0]!.ts).toBe(1_700_000_000_000)
    expect(tail.at(-1)!.ts).toBe(1_700_000_000_000 + total - 1)
  })

  it('still honours a small tail exactly', async () => {
    const { files, dir } = await makeLogs()
    await fs.promises.mkdir(path.join(dir, 'logs'), { recursive: true })
    await fs.promises.writeFile(
      path.join(dir, 'logs', 'web.log'),
      `${Array.from({ length: 1200 }, (_, i) => jsonLine(i)).join('\n')}\n`,
    )

    const tail = files.readTail('web', 3)
    expect(tail.map(line => line.ts)).toEqual([1_700_000_000_000 + 1197, 1_700_000_000_000 + 1198, 1_700_000_000_000 + 1199])
  })

  /**
   * The route widens its window to `MAX_TAIL` (5000) whenever a search is present, so the
   * truncation had a second symptom: a match near the start of that window was never read, and
   * the UI reported "no results" for a line that exists.
   */
  it('reaches a match that sits at the start of the search window', async () => {
    const { files, dir } = await makeLogs()
    await fs.promises.mkdir(path.join(dir, 'logs'), { recursive: true })
    const marked = (i: number): string =>
      JSON.stringify({ ts: 1_700_000_000_000 + i, stream: 'stdout', text: i === 10 ? 'NEEDLE' : `line ${i} ${'x'.repeat(120)}` })
    await fs.promises.writeFile(
      path.join(dir, 'logs', 'web.log'),
      `${Array.from({ length: 5000 }, (_, i) => marked(i)).join('\n')}\n`,
    )

    const window = files.readTail('web', 5000)
    expect(window).toHaveLength(5000)
    expect(window.filter(line => line.text.includes('NEEDLE'))).toHaveLength(1)
  })

  it('pads a short current file from its rotation, in order', async () => {
    const { files, dir } = await makeLogs()
    await fs.promises.mkdir(path.join(dir, 'logs'), { recursive: true })
    await fs.promises.writeFile(path.join(dir, 'logs', 'web.log'), `${jsonLine(100)}\n${jsonLine(101)}\n`)
    await fs.promises.writeFile(path.join(dir, 'logs', 'web.log.1'), `${jsonLine(98)}\n${jsonLine(99)}\n`)

    expect(files.readTail('web', 4).map(line => line.ts)).toEqual([98, 99, 100, 101].map(offset => 1_700_000_000_000 + offset))
  })
})

/**
 * The values the Logs page actually offers, against a log of realistic size.
 *
 * The dropdown is 200 / 500 / 2000 / 5000, and one 256 KB read window holds only ~1300 lines
 * at 200 bytes each — so "2000 lines" and "5000 lines" were silently short for ordinary
 * content, not just for an API caller asking for an extreme. This pins the numbers a person
 * picks from the UI rather than a synthetic tail.
 */
describe('the tail sizes the Logs page offers', () => {
  it('returns as many lines as the dropdown says, from a real-size log', async () => {
    const { files, dir } = await makeLogs()
    await fs.promises.mkdir(path.join(dir, 'logs'), { recursive: true })
    const total = 3000
    const line = (i: number): string =>
      JSON.stringify({ ts: 1_700_000_000_000 + i, stream: 'stdout', text: `line ${i} ${'x'.repeat(180)}` })
    await fs.promises.writeFile(
      path.join(dir, 'logs', 'web.log'),
      `${Array.from({ length: total }, (_, i) => line(i)).join('\n')}\n`,
    )

    // 200 bytes a line is ~730 KB of file, so any window smaller than the whole thing proves
    // the reader grew to meet the request.
    for (const asked of [200, 500, 2000]) {
      expect(files.readTail('web', asked), `asked ${asked}`).toHaveLength(asked)
    }
    // More than the file holds: everything there is, and the true oldest line first.
    const all = files.readTail('web', 5000)
    expect(all).toHaveLength(total)
    expect(all[0]!.ts).toBe(1_700_000_000_000)
  })
})

/**
 * `keep` is a promise about the directory, not about a rename loop.
 *
 * Three readers disagreed with it in the same way: the list, the size and the tail all believed
 * `keep` described what was on disk, so a rotation numbered above it was invisible, unreadable
 * and unremovable. The tail half is the damaging one — a search that answers "no matches" while
 * the matching line sits on the disk is worse than a shorter window.
 */
describe('what `keep` actually bounds', () => {
  const jsonLine = (i: number, text = `line ${i}`): string =>
    JSON.stringify({ ts: 1_700_000_000_000 + i, stream: 'stdout', text: `${text} ${'x'.repeat(100)}` })

  async function writeRotations(dir: string, count: number, perFile = 10, text?: (i: number) => string): Promise<void> {
    await fs.promises.mkdir(path.join(dir, 'logs'), { recursive: true })
    for (let file = 0; file <= count; file++) {
      const name = file === 0 ? 'web.log' : `web.log.${file}`
      const from = (count - file) * perFile
      await fs.promises.writeFile(
        path.join(dir, 'logs', name),
        `${Array.from({ length: perFile }, (_, n) => jsonLine(from + n, text?.(from + n))).join('\n')}\n`,
      )
    }
  }

  it('reads past `.1` into every rotation it kept', async () => {
    const { files, dir } = await makeLogs({ maxBytes: 10000, keep: 3 })
    await writeRotations(dir, 3)

    // Four files of ten lines each; the old reader walked the current file and `.1` only.
    const tail = files.readTail('web', 40)
    expect(tail).toHaveLength(40)
    expect(tail[0]!.ts).toBe(1_700_000_000_000)
  })

  it('finds a match that sits in the oldest retained rotation', async () => {
    const { files, dir } = await makeLogs({ maxBytes: 10000, keep: 3 })
    await writeRotations(dir, 3, 10, i => (i === 0 ? 'NEEDLE the deploy failed' : `line ${i}`))

    const window = files.readTail('web', 5000)
    expect(window.filter(line => line.text.includes('NEEDLE')), 'a search must not report "nothing found" for a line on disk').toHaveLength(1)
  })

  it('reports the size of everything it lists, not only the newest file', async () => {
    const { files, dir } = await makeLogs({ maxBytes: 10000, keep: 2 })
    await writeRotations(dir, 2, 10)

    const info = files.info('web')
    expect(info.files).toHaveLength(3)
    const summed = info.files.reduce((total, file) => total + file.sizeBytes, 0)
    expect(info.sizeBytes, 'the "on disk" total must be the files it lists').toBe(summed)
  })

  it('drops the rotations a lowered `keep` no longer covers', async () => {
    const { dir } = await makeLogs({ maxBytes: 10000, keep: 5 })
    await writeRotations(dir, 5)
    // A person lowers the ceiling from the settings page; nothing renames down.
    const lowered = new LogFiles(path.join(dir, 'logs'), () => ({ persist: true, maxBytes: 10000, keep: 1 }))

    expect(lowered.info('web').files.map(file => file.name)).toEqual(['web.log', 'web.log.1'])
    // A rotation is what runs the prune — the one path that already walks the ceiling — so
    // write past `maxBytes` and let one happen.
    for (let index = 0; index < 200; index++) lowered.append('web', { ts: 1_700_000_000_000 + index, stream: 'stdout', text: `fresh ${index} ${'x'.repeat(100)}` })
    lowered.flush()

    const left = await fs.promises.readdir(path.join(dir, 'logs'))
    const rotations = left.filter(name => name.startsWith('web.log.')).sort()
    expect(rotations, `files left after lowering keep: ${left.join(', ')}`).toEqual(['web.log.1'])
  })

  it('prunes on demand, so lowering `keep` does not wait for the next rotation', async () => {
    const { dir } = await makeLogs({ maxBytes: 10000, keep: 5 })
    await writeRotations(dir, 5)
    // A quiet entry may not fill a file for days; the settings save must not leave `.2`…`.5`
    // sitting there until it does.
    const lowered = new LogFiles(path.join(dir, 'logs'), () => ({ persist: true, maxBytes: 10000, keep: 1 }))

    lowered.prune()

    const rotations = (await fs.promises.readdir(path.join(dir, 'logs')))
      .filter(name => name.startsWith('web.log.'))
      .sort()
    expect(rotations, 'a lowered ceiling must take effect when it is saved').toEqual(['web.log.1'])
    expect(lowered.info('web').files.map(file => file.name)).toEqual(['web.log', 'web.log.1'])
  })

  it('clears every rotation the id owns, including ones `keep` no longer names', async () => {
    const { files, dir } = await makeLogs({ maxBytes: 10000, keep: 1 })
    await writeRotations(dir, 5)

    files.clear('web')
    const left = await fs.promises.readdir(path.join(dir, 'logs')).catch(() => [] as string[])
    expect(left, 'a delete must not leave the files it did not think it had').toEqual([])
  })
})
