import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { followLog, readLog, tailLog } from '#src/helpers/daemon-log'

/**
 * The panel's own console log is the only record of a panel that runs but misbehaves.
 * `up` prints it when the panel *fails* to start; after that there was no way to see it
 * short of knowing the path and reading the bytes.
 */

const dirs: string[] = []

function tempLog(contents: string | null, rotated: string | null = null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-daemon-log-'))
  dirs.push(dir)
  const file = path.join(dir, 'home-hosted.log')
  if (rotated !== null)
    fs.writeFileSync(`${file}.1`, rotated)
  if (contents !== null)
    fs.writeFileSync(file, contents)
  return file
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

describe('readLog', () => {
  it('reads the tail, and the whole file when asked for no limit', () => {
    const file = tempLog('a\nb\nc\nd\n')
    expect(readLog(file, 2)).toEqual(['c', 'd'])
    expect(readLog(file, 0)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('puts the rotated file before the current one', () => {
    // Otherwise a rotation silently loses whatever was written just before it.
    const file = tempLog('new-1\nnew-2\n', 'old-1\nold-2\n')
    expect(readLog(file, 3)).toEqual(['old-2', 'new-1', 'new-2'])
    expect(readLog(file, 0)).toEqual(['old-1', 'old-2', 'new-1', 'new-2'])
  })

  it('does not invent a trailing blank line', () => {
    // A file ends with a newline; splitting on it leaves one empty entry behind.
    expect(readLog(tempLog('only\n'), 0)).toEqual(['only'])
  })

  it('is empty, not an error, when there is no log at all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-daemon-log-'))
    dirs.push(dir)
    expect(readLog(path.join(dir, 'missing.log'), 10)).toEqual([])
  })

  it('reads a log shorter than the limit without padding or throwing', () => {
    expect(readLog(tempLog('one\n'), 50)).toEqual(['one'])
  })
})

describe('tailLog', () => {
  it('returns the last lines as one string, and nothing for a missing file', () => {
    const file = tempLog('a\nb\nc\n')
    expect(tailLog(file, 2)).toBe('b\nc')
    // `up` prints this when the panel fails to start, so a missing file must not throw.
    expect(tailLog(path.join(path.dirname(file), 'nope.log'))).toBe('')
  })
})

describe('runLogs', () => {
  // `daemonLogPath` resolves `$HHOSTED_HOME` at import time, so each case points it at its
  // own temp home and re-imports — the pattern the other CLI tests use.
  const savedHome = process.env.HHOSTED_HOME

  afterEach(() => {
    if (savedHome === undefined)
      delete process.env.HHOSTED_HOME
    else
      process.env.HHOSTED_HOME = savedHome
    vi.resetModules()
  })

  async function capture(home: string, input: { lines?: string, json?: boolean }): Promise<string> {
    process.env.HHOSTED_HOME = home
    vi.resetModules()
    const { runLogs } = await import('#src/cli/logs')
    const wrote: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      wrote.push(String(chunk))
      return true
    })
    try {
      await runLogs(input)
    }
    finally {
      spy.mockRestore()
    }
    return wrote.join('')
  }

  function home(contents: string | null, rotated: string | null = null): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-logs-cli-'))
    dirs.push(dir)
    fs.mkdirSync(path.join(dir, '.hh', '.logs'), { recursive: true })
    if (rotated !== null)
      fs.writeFileSync(path.join(dir, '.hh', '.logs', 'home-hosted.log.1'), rotated)
    if (contents !== null)
      fs.writeFileSync(path.join(dir, '.hh', '.logs', 'home-hosted.log'), contents)
    return dir
  }

  it('writes the lines, prefixed by the path it read', async () => {
    const root = home('first\nsecond\n')
    const output = await capture(root, { lines: '2' })
    expect(output).toContain('second')
    expect(output).toContain(path.join('.hh', '.logs', 'home-hosted.log'))
  })

  it('honours `all`, and falls back to the default on a value it cannot read', async () => {
    const root = home('old\nnew\n', 'rotated\n')
    expect(await capture(root, { lines: 'all' })).toContain('rotated')
    // A bad count is a typo, not a reason to fail.
    expect(await capture(root, { lines: 'seven' })).toContain('new')
  })

  it('emits JSON a script can read', async () => {
    const root = home('only\n')
    const parsed = JSON.parse(await capture(root, { json: true }))
    expect(parsed.lines).toEqual(['only'])
    expect(parsed.path).toContain('home-hosted.log')
  })

  it('says so plainly when the panel has not written anything yet', async () => {
    const root = home(null)
    expect(await capture(root, {})).toContain('no output yet')
  })

  /**
   * A *partly* numeric count is not a typo, and must not become a number nobody asked for.
   *
   * An unreadable count falls back to the default on purpose. But `Number.parseInt` also accepts a
   * prefix, so `1e3` meant 1 line where the caller reasonably meant 1000, and `0x10` parsed as 0 —
   * the "whole log" sentinel, so a bounded request became unbounded. The whole trimmed argument now
   * has to be a decimal integer.
   */
  it('falls back to the default rather than a partial parse', async () => {
    const root = home(`${Array.from({ length: 200 }, (_, i) => `line-${i}`).join('\n')}\n`)

    for (const raw of ['1e3', '0x10', '12abc', '3.7']) {
      const printed = (await capture(root, { lines: raw })).split('\n').filter(line => line.startsWith('line-')).length
      expect(printed, `--lines ${raw} printed ${printed} lines`).toBe(50)
    }
  })

  it('still honours a real count, `all`, and a negative as everything', async () => {
    const root = home(`${Array.from({ length: 200 }, (_, i) => `line-${i}`).join('\n')}\n`)
    const printed = async (raw: string): Promise<number> =>
      (await capture(root, { lines: raw })).split('\n').filter(line => line.startsWith('line-')).length

    expect(await printed('5')).toBe(5)
    expect(await printed('150')).toBe(150)
    // `0x10` must not reach the "everything" branch that a negative legitimately reaches.
    expect(await printed('-1')).toBe(200)
    expect(await printed('all')).toBe(200)
  })

  it('accepts surrounding whitespace on a real count', async () => {
    // A shell can hand over a padded value; that is still the number it looks like.
    expect(await capture(home('a\nb\nc\n'), { lines: ' 2 ' })).toContain('c')
  })

  /**
   * `--follow --json` must emit one JSON object per line.
   *
   * It used to ignore `--json` entirely and print raw text, while the synopsis
   * (`logs [--lines <n>] [--follow] [--json]`) advertised the flags as composable. A stream has no
   * single document, so its machine-readable form is one object per line — each carrying the
   * `path` the one-shot form reports, since a consumer following a panel should not need
   * out-of-band knowledge of which file it is reading.
   */
  it('emits one JSON object per line when following', async () => {
    const root = home('a\nb\n\nc\n')
    const written: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      written.push(String(chunk))
      return true
    }) as never)

    try {
      process.env.HHOSTED_HOME = root
      vi.resetModules()
      const { runLogs } = await import('#src/cli/logs')
      // `followLog` polls until interrupted, so the signal ends it.
      const running = runLogs({ follow: true, json: true })
      await new Promise(resolve => setTimeout(resolve, 600))
      process.emit('SIGINT')
      await running
    }
    finally {
      spy.mockRestore()
    }

    const parsed = written
      .join('')
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as { path: string, line: string })

    // Every object names the file it came from — the one-shot form's `path`.
    expect(parsed.length).toBeGreaterThan(0)
    expect(parsed.every(entry => entry.path.endsWith(path.join('.hh', '.logs', 'home-hosted.log')))).toBe(true)
    // The blank line the panel wrote is output the person asked for, so it is an object too —
    // and no fragment of it is emitted as a line of its own.
    expect(parsed.map(entry => entry.line)).toEqual(['a', 'b', '', 'c'])
  })
})

describe('followLog', () => {
  it('prints what is there, then whatever is appended', async () => {
    const file = tempLog('existing\n')
    const chunks: string[] = []
    const controller = new AbortController()

    const following = followLog(file, 10, chunk => chunks.push(chunk), 25)
    await new Promise(resolve => setTimeout(resolve, 80))
    fs.appendFileSync(file, 'appended\n')
    await new Promise(resolve => setTimeout(resolve, 150))
    process.emit('SIGINT')
    await following
    controller.abort()

    expect(chunks.join('')).toContain('existing')
    expect(chunks.join('')).toContain('appended')
  })

  it('starts again from the top when the log is rotated under it', async () => {
    // What `up` does on a restart: the current file becomes `.1` and a fresh one appears,
    // so the file gets *smaller*. A follow that only tracked an offset would print nothing.
    const file = tempLog('before-rotation\n')
    const chunks: string[] = []
    const following = followLog(file, 10, chunk => chunks.push(chunk), 25)
    await new Promise(resolve => setTimeout(resolve, 80))

    fs.writeFileSync(file, 'after-rotation\n')
    await new Promise(resolve => setTimeout(resolve, 150))
    process.emit('SIGINT')
    await following

    expect(chunks.join('')).toContain('after-rotation')
  })
})

describe('followLog preserves what it reads', () => {
  /**
   * A poll can land mid-line or mid-blank-run, and the bytes must survive either way.
   *
   * The first version rewrote each chunk with `replace(/\n+$/, '\n')`, meant to stop a
   * partially written last line being "glued" to the next read. It did something else
   * entirely: it collapsed a trailing run of newlines to one, so a blank line the panel had
   * written was **eaten** — the read offset had already advanced past it, so nothing brought
   * it back. Blank lines are common in this log (section breaks, stack traces), and `logs` is
   * a diagnostic command: quietly dropping its output is the worst thing it can do.
   *
   * A partial line is not a problem to solve. Printing the fragment and letting the next poll
   * append the rest is exactly what `tail -f` does.
   */
  async function followWriting(writes: Array<[string, number]>): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-follow-'))
    dirs.push(dir)
    const file = path.join(dir, 'app.log')
    fs.writeFileSync(file, '')
    const chunks: string[] = []
    const following = followLog(file, 10, chunk => chunks.push(chunk), 20)
    await new Promise(resolve => setTimeout(resolve, 50))
    for (const [text, wait] of writes) {
      fs.appendFileSync(file, text)
      await new Promise(resolve => setTimeout(resolve, wait))
    }
    process.emit('SIGINT')
    await following
    return chunks.join('')
  }

  it('keeps a blank line that a poll caught at the end of a chunk', async () => {
    expect(await followWriting([['a\n\n', 150], ['b\n', 150]])).toBe('a\n\nb\n')
  })

  it('keeps a run of blank lines', async () => {
    expect(await followWriting([['x\n\n\n\n', 150], ['y\n', 150]])).toBe('x\n\n\n\ny\n')
  })

  it('keeps a partial line, without duplicating or dropping it', async () => {
    // The half-line is printed as it stands and completed by the next read.
    expect(await followWriting([['hel', 120], ['lo\n', 150]])).toBe('hello\n')
  })
})

describe('readLog reads only the tail it needs', () => {
  /** Distinct lines, so a one-line shift at a block boundary cannot go unnoticed. */
  function numbered(prefix: string, count: number): string {
    return Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join('')
  }

  /** The implementation this replaced: everything, then the last N lines. */
  function readEverything(file: string, lines: number): string[] {
    const parts: string[] = []
    for (const candidate of [`${file}.1`, file]) {
      try {
        parts.push(fs.readFileSync(candidate, 'utf8'))
      }
      catch { /* missing is normal */ }
    }
    const all = parts.join('').split('\n')
    if (all.at(-1) === '')
      all.pop()
    return lines > 0 ? all.slice(-lines) : all
  }

  /** A rotated pair, oldest first, as the panel leaves them. */
  function rotatedPair(rotated: string, current: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-readlog-'))
    dirs.push(dir)
    const file = path.join(dir, 'app.log')
    if (rotated !== '__missing__')
      fs.writeFileSync(`${file}.1`, rotated)
    if (current !== '__missing__')
      fs.writeFileSync(file, current)
    return file
  }

  /**
   * A tail reader that returns a *different* answer is worse than a slow one, so this pins
   * equivalence with the full read across the shapes that actually occur — including the join
   * where `.1` has no trailing newline, which makes its last line and the current file's first
   * line one line.
   */
  it('returns exactly what reading everything would, across the awkward shapes', () => {
    const shapes: Array<[string, string, string]> = [
      ['both empty', '', ''],
      ['only the current file', '', 'a\nb\nc\n'],
      ['only the rotation', 'x\ny\n', ''],
      ['neither file exists', '__missing__', '__missing__'],
      ['neither ends in a newline', 'x\ny', 'a\nb'],
      ['the rotation has no trailing newline', 'x\ny', 'a\nb\n'],
      ['the current file has no trailing newline', 'x\ny\n', 'a\nb'],
      ['blank lines at the join', 'p\n\n\n\n', '\n\n\nq\n'],
      ['a line longer than one read block', `${'x'.repeat(200_000)}\ntail\n`, 'a\nb\n'],
      ['CRLF line endings', 'a\r\nb\r\n', 'c\r\nd\r\n'],
      ['one line each', 'one\n', 'two\n'],
      // Past one 64 KB read block, so the backwards read loops and its first (partial) line
      // has to be dropped. Small inputs never reach that code, which is how a mutation there
      // survived this test until these shapes were added.
      // Distinct numbers, not a repeated string: identical lines make the tail the same
      // whether or not the partial leading line was dropped, which hides a boundary bug.
      ['many lines across blocks', numbered('rot', 9000), numbered('cur', 9000)],
      ['a long line ending mid-block', `${'x'.repeat(90_000)}\n${`${'y'.repeat(70_000)}\n`}`, 'a\nb\n'],
    ]

    for (const [name, rotated, current] of shapes) {
      const file = rotatedPair(rotated, current)
      for (const lines of [0, 1, 2, 3, 5, 50, 100_000]) {
        expect(readLog(file, lines), `${name}, lines=${lines}`).toEqual(readEverything(file, lines))
      }
    }
  })

  it('does not read the whole file to answer for fifty lines', async () => {
    // The point of the change: 24 ms and 28 MB of heap to print fifty lines from a 10 MB
    // pair. This asserts the shape of the fix rather than a wall-clock number, which would be
    // flaky on CI: the read is bounded, so peak allocation stays small.
    const line = 'x'.repeat(200)
    const file = rotatedPair(`${line}\n`.repeat(20_000), `${line}\n`.repeat(20_000))
    const before = process.memoryUsage().heapUsed
    const tail = readLog(file, 50)
    const grew = (process.memoryUsage().heapUsed - before) / 1e6
    expect(tail).toHaveLength(50)
    // Reading both 4 MB files into strings and splitting them grew the heap by tens of MB.
    expect(grew, `heap grew ${grew.toFixed(1)} MB for a 50-line tail`).toBeLessThan(5)
  })
})
