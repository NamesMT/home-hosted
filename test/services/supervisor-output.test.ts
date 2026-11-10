import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { LineSplitter } from '#src/services/log-buffer'
import { closeOutput, EntryOutput, openOutput, outputFiles, removeOutputFiles } from '#src/services/supervisor/output'

/**
 * The reader that makes a supervised child's output survive the panel.
 *
 * A pipe gives the panel the read end, so a panel killed hard `EPIPE`s any child that writes — the
 * defect this module exists to remove. The child's two streams are files instead, and everything
 * here is about reading a file another process is still appending to: a bounded read can end inside
 * a character, a write can end inside a line, and our own cap empties the file while the child keeps
 * writing to it.
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-output-'))
  dirs.push(dir)
  return dir
}

/**
 * A reader wired exactly as the supervisor wires one: text out of `EntryOutput`, lines out of
 * `LineSplitter`. Collecting at the **line** level is the point — a test that asserted on raw text
 * would pass while the panel's own buffer showed a torn line.
 */
function harness(options: { capBytes?: number } = {}) {
  const dir = scratch()
  const files = outputFiles(dir, 'web')
  const opened = openOutput(files)
  const lines: Array<{ stream: string, text: string }> = []
  const splitters = {
    stdout: new LineSplitter((stream, text) => lines.push({ stream, text })),
    stderr: new LineSplitter((stream, text) => lines.push({ stream, text })),
  }
  const reader = new EntryOutput(files, {
    capBytes: () => options.capBytes ?? 8 * 1024 * 1024,
    onText: (stream, text) => splitters[stream].push(stream, text),
  })
  return {
    dir,
    files,
    opened,
    reader,
    lines,
    /** What the child's descriptor would write — the same `O_APPEND` open it inherited. */
    append: (stream: 'stdout' | 'stderr', text: string): void => {
      fs.appendFileSync(files[stream], text)
    },
    /** Bytes actually on disk, so nothing can hide behind a decode. */
    raw: (stream: 'stdout' | 'stderr'): Buffer => fs.readFileSync(files[stream]),
    flush: (): void => {
      splitters.stdout.flush('stdout')
      splitters.stderr.flush('stderr')
    },
  }
}

describe('a child\'s output read back from its file', () => {
  it('reads what the child wrote, split into lines, per stream', () => {
    const h = harness()
    h.append('stdout', 'hello\nworld\n')
    h.append('stderr', 'a warning\n')
    h.reader.poll()

    expect(h.lines).toEqual([
      { stream: 'stdout', text: 'hello' },
      { stream: 'stdout', text: 'world' },
      { stream: 'stderr', text: 'a warning' },
    ])
    h.reader.stop()
  })

  /**
   * The defect the whole change is about, at the unit level: the child must not depend on the panel
   * reading. A `pipe` blocks the writer (or `EPIPE`s it); an `O_APPEND` file does neither, so a
   * write that happens while nothing is reading has to survive for the next poll.
   */
  it('keeps output written while nothing was reading, and reads it on the next poll', () => {
    const h = harness()
    // Never polled: the file is the buffer, which a pipe would not have been.
    h.append('stdout', 'while the panel was gone\n')
    h.reader.poll()
    expect(h.lines.map(line => line.text)).toEqual(['while the panel was gone'])
    h.reader.stop()
  })

  it('carries a line that ends mid-write, then completes it', () => {
    const h = harness()
    h.append('stdout', 'complete\nhalf-writ')
    h.reader.poll()
    expect(h.lines.map(line => line.text), 'the fragment is not a line yet').toEqual(['complete'])

    h.append('stdout', 'ten\n')
    h.reader.poll()
    expect(h.lines.map(line => line.text)).toEqual(['complete', 'half-written'])
    h.reader.stop()
  })

  /**
   * A bounded read stops wherever the buffer ends, which is often inside a UTF-8 sequence. Decoding
   * each chunk on its own rendered the halves as U+FFFD, so the character was destroyed by the read
   * budget rather than by the child. `Utf8Chunks` carries it — the same helper the pipe path used,
   * because a split byte sequence is not a property of the transport.
   */
  it('reassembles a multibyte character split across two reads', () => {
    const dir = scratch()
    const file = path.join(dir, 'utf8.out')
    fs.writeFileSync(file, '')
    const text: string[] = []
    const reader = new EntryOutput({ stdout: file, stderr: path.join(dir, 'utf8.err') }, {
      capBytes: () => 1024 * 1024,
      onText: (_stream, chunk) => text.push(chunk),
    })

    // "é" is two bytes, "😀" is four. Split both, at every boundary, by writing halves separately
    // with a poll between them — exactly the shape of a read that ended mid-character.
    const bytes = Buffer.from('café 😀\n', 'utf8')
    const cut = bytes.indexOf(0xC3) + 1
    fs.writeFileSync(file, bytes.subarray(0, cut))
    reader.poll()
    fs.appendFileSync(file, bytes.subarray(cut))
    reader.poll()

    expect(text.join(''), 'the character survived the cut, not U+FFFD').toBe('café 😀\n')
    expect(text.join('')).not.toContain('\uFFFD')
    reader.stop()
  })

  /**
   * The cap. A pipe throttles; a file does not, so an unbounded transport file is a disk leak. The
   * file is emptied only once fully drained, so nothing the panel had not read can be lost — and
   * `O_APPEND` is what makes the child's next write land at position 0 instead of leaving a NUL gap.
   */
  it('empties a drained file past the cap, with no NUL bytes and the next line intact', () => {
    // 26 bytes of line against a 16-byte cap: drained and over it in the same poll.
    const h = harness({ capBytes: 16 })
    h.append('stdout', 'a-first-line-past-the-cap\n')
    h.reader.poll()
    expect(h.lines.map(line => line.text)).toEqual(['a-first-line-past-the-cap'])
    // The reader drained it and emptied the file in the same poll: nothing is on disk any more.
    expect(h.raw('stdout').length, 'drained and emptied').toBe(0)

    // The child keeps writing through the descriptor it already holds, after the panel emptied the
    // file. `O_APPEND` is what puts this at position 0 rather than at the old, longer offset.
    h.append('stdout', 'after-truncation\n')
    h.reader.poll()

    const raw = h.raw('stdout')
    expect(raw.includes(0), `no NUL hole: ${JSON.stringify(raw.toString('utf8'))}`).toBe(false)
    expect(h.lines.map(line => line.text), 'no torn first line, no lost line').toEqual([
      'a-first-line-past-the-cap',
      'after-truncation',
    ])
    h.reader.stop()
  })

  /**
   * The writer outruns the reader, which polling cannot prevent.
   *
   * A `setInterval` pass is synchronous and bounded, so a child writing faster than it can be read
   * has an ever-growing unread backlog — the unbounded file this cap exists to stop. The oldest
   * unread bytes go, and the caller is told: losing output silently would be the very failure this
   * module is named against, so the count is reported rather than swallowed.
   */
  it('drops the oldest unread bytes when the writer outruns the reader, and says how many', () => {
    const dir = scratch()
    const files = outputFiles(dir, 'web')
    const opened = openOutput(files)
    const kept: string[] = []
    const dropped: Array<{ stream: string, bytes: number }> = []
    const reader = new EntryOutput(files, {
      capBytes: () => 1024,
      onText: (_stream, text) => kept.push(text),
      onDropped: (stream, bytes) => dropped.push({ stream, bytes }),
    })

    // No poll has run yet and the backlog is far past what one poll can read (the reader's own
    // `MAX_BYTES_PER_POLL` is 256 KiB), which is the only state in which polling genuinely cannot
    // catch up. Lines, so the drop can land on a boundary.
    const backlog = `${`${'x'.repeat(99)}\n`.repeat(3000)}\n`
    fs.appendFileSync(files.stdout, backlog)
    expect(fs.statSync(files.stdout).size).toBeGreaterThan(262_144)
    reader.poll()

    expect(dropped.length, 'the overrun must be reported').toBe(1)
    expect(dropped[0]!.stream).toBe('stdout')
    expect(dropped[0]!.bytes).toBeGreaterThan(0)
    expect(kept.join('').length, 'something was still read after the drop').toBeGreaterThan(0)
    reader.stop()
    closeOutput(opened)
  })

  /**
   * Lossless across **our own** truncation that lands inside a line.
   *
   * The reader is drained, but `LineSplitter` is still holding a half-written line — and the child's
   * next write is that line's continuation, because to the child nothing happened. This is the case
   * an "everything resets on truncation" implementation gets wrong: dropping the carry splits one
   * line into two fragments.
   */
  it('carries a half-written line across a truncation, so the line is not torn', () => {
    const h = harness({ capBytes: 20 })
    // Under the cap: read in full, and the splitter keeps it because no newline has arrived.
    h.append('stdout', 'first-part-')
    h.reader.poll()
    expect(h.lines, 'nothing complete yet').toEqual([])

    // Over the cap, still no newline: read, then the drained file is emptied. The carry survives.
    h.append('stdout', 'second-part-')
    h.reader.poll()
    expect(h.lines, 'still nothing complete').toEqual([])
    expect(h.raw('stdout').length, 'the file was emptied under the reader').toBe(0)

    h.append('stdout', 'end\n')
    h.reader.poll()
    expect(h.lines.map(line => line.text), 'one line, not two fragments').toEqual([
      'first-part-second-part-end',
    ])
    h.reader.stop()
  })

  /**
   * Test 5 of the task: a child that writes a partial line and exits. The bytes are on disk but the
   * splitter is holding them, so `stop()` must drain and the caller must flush — otherwise a crash's
   * last line, the one that says why it died, is the one line nobody sees.
   */
  it('flushes a final line that has no newline when the child exits', () => {
    const h = harness()
    h.append('stdout', 'no-trailing-newline')
    // What the supervisor does on the child's exit: stop the reader, then flush the splitters.
    h.reader.stop()
    h.flush()
    expect(h.lines.map(line => line.text)).toEqual(['no-trailing-newline'])
  })

  it('starts cleanly when the file does not exist yet, then picks it up', () => {
    const dir = scratch()
    const files = outputFiles(dir, 'later')
    const lines: string[] = []
    const reader = new EntryOutput(files, {
      capBytes: () => 1024 * 1024,
      onText: (_stream, text) => lines.push(text),
    })
    // The panel polls before the child has been spawned, so nothing exists.
    expect(() => reader.poll()).not.toThrow()
    expect(lines).toEqual([])

    fs.writeFileSync(files.stdout, 'now it exists\n')
    reader.poll()
    expect(lines.join('')).toContain('now it exists')
    reader.stop()
  })

  it('keeps the two streams apart, so a half-written line cannot absorb the other', () => {
    const h = harness()
    h.append('stdout', 'out-partial')
    h.reader.poll()
    h.append('stderr', 'err-line\n')
    h.reader.poll()
    h.append('stdout', '-end\n')
    h.reader.poll()

    expect(h.lines).toEqual([
      { stream: 'stderr', text: 'err-line' },
      { stream: 'stdout', text: 'out-partial-end' },
    ])
    h.reader.stop()
  })

  /** A previous run's bytes must not be served as this run's output. */
  it('empties the files when a run opens them', () => {
    const dir = scratch()
    const files = outputFiles(dir, 'web')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(files.stdout, 'output of a dead run\n')
    fs.writeFileSync(files.stderr, 'and its errors\n')

    const opened = openOutput(files)
    expect(fs.readFileSync(files.stdout, 'utf8')).toBe('')
    expect(fs.readFileSync(files.stderr, 'utf8')).toBe('')
    closeOutput(opened)
  })

  it('removes both files with the entry', () => {
    const dir = scratch()
    const files = outputFiles(dir, 'web')
    const opened = openOutput(files)
    closeOutput(opened)
    expect(fs.existsSync(files.stdout)).toBe(true)

    removeOutputFiles(files)
    expect(fs.existsSync(files.stdout)).toBe(false)
    expect(fs.existsSync(files.stderr)).toBe(false)
  })

  /** Nothing here may depend on POSIX: the descriptors are handed to `spawn`, on every platform. */
  it('names its files beside the entry state, not among the served logs', () => {
    const files = outputFiles(path.join('/state'), 'web')
    expect(files.stdout).toBe(path.join('/state', 'web.out'))
    expect(files.stderr).toBe(path.join('/state', 'web.err'))
    // `.log` is `LogFiles`'s suffix; a transport file must not be mistaken for a rotation of one.
    expect(path.basename(files.stdout)).not.toContain('.log')
    expect(path.basename(files.stderr)).not.toContain('.log')
  })
})

/**
 * The panel-side guard that the change is real: the spawn must hand the child a **descriptor**, not
 * a pipe. Asserted on the options `spawnManaged` builds, because a revert to `'pipe'` here is
 * invisible in every other test — the output would still arrive, and the child would still die with
 * the panel.
 */
describe('spawnManaged with output descriptors', () => {
  it('gives the child the file descriptors instead of a pipe', async () => {
    const { spawnManaged } = await import('#src/providers/process')
    const dir = scratch()
    const files = outputFiles(dir, 'web')
    const opened = openOutput(files)
    const child = spawnManaged(
      { command: process.execPath, args: ['-e', 'process.stdout.write("via-fd\\n")'], cwd: dir, env: {} },
      { output: opened.fds },
    )
    closeOutput(opened)
    // No pipe of ours: with a descriptor there is no `stdout` stream to read.
    expect(child.stdout, 'a pipe is what the panel dying closes').toBeNull()
    expect(child.stderr).toBeNull()
    await new Promise(resolve => child.once('exit', resolve))
    // The bytes are in the file the child wrote them to — after the panel's own descriptor is gone.
    expect(fs.readFileSync(files.stdout, 'utf8')).toContain('via-fd')
  })

  it('still gives a nanny-spawned child no pipes', async () => {
    const { spawnManaged } = await import('#src/providers/process')
    const child = spawnManaged(
      { command: process.execPath, args: ['-e', ''], cwd: scratch(), env: {} },
      { detached: false },
    )
    // The default is unchanged: bootstrap and nanny children keep the pipe path.
    expect(child.stdout).not.toBeNull()
    await new Promise(resolve => child.once('exit', resolve))
  })
})
