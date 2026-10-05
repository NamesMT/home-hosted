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
