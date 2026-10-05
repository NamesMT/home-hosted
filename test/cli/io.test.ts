import process from 'node:process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bold, cyan, dim, green, heading, isTty, paint, style } from '#src/cli/io'

/**
 * The colour seam every command prints through.
 *
 * `paint` is gated on `stdout.isTTY`, which is what keeps a piped or redirected run
 * (a script, CI, `home-hosted status | jq`) free of escape codes. That gate is the whole
 * behaviour of this module and had no test of its own.
 */

const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

afterEach(() => {
  if (original === undefined)
    delete (process.stdout as { isTTY?: boolean }).isTTY
  else
    Object.defineProperty(process.stdout, 'isTTY', original)
  vi.restoreAllMocks()
})

function setTty(value: boolean | undefined): void {
  if (value === undefined)
    delete (process.stdout as { isTTY?: boolean }).isTTY
  else
    Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true, writable: true })
}

describe('cli io', () => {
  it('reads the terminal from stdout, and treats a missing value as no terminal', () => {
    setTty(true)
    expect(isTty()).toBe(true)
    setTty(false)
    expect(isTty()).toBe(false)
    // A pipe leaves the property undefined rather than false.
    setTty(undefined)
    expect(isTty()).toBe(false)
  })

  it('emits an escape sequence only on a terminal', () => {
    setTty(true)
    expect(paint('31', 'boom')).toBe('\x1B[31mboom\x1B[0m')

    setTty(false)
    // Byte-identical to the input, so a redirected run stays plain text.
    expect(paint('31', 'boom')).toBe('boom')
    setTty(undefined)
    expect(paint('31', 'boom')).toBe('boom')
  })

  it('wraps every exported colour through that one gate', () => {
    setTty(false)
    for (const [name, fn] of Object.entries({ dim, bold, cyan, green, heading }))
      expect(fn('x'), name).toBe('x')

    setTty(true)
    expect(dim('x')).toBe('\x1B[2mx\x1B[0m')
    expect(bold('x')).toBe('\x1B[1mx\x1B[0m')
    expect(cyan('x')).toBe('\x1B[36mx\x1B[0m')
    expect(green('x')).toBe('\x1B[32mx\x1B[0m')
    // A heading is bold and underlined together.
    expect(heading('x')).toBe('\x1B[1;4mx\x1B[0m')
  })

  it('exposes the three colours a caller injects, and nothing else', () => {
    expect(Object.keys(style).sort()).toEqual(['bold', 'dim', 'green'])
    expect(style.bold).toBe(bold)
    expect(style.dim).toBe(dim)
    expect(style.green).toBe(green)
  })

  /**
   * `fail` is the one error shape: a message on stderr and exit 1. Commands rely on it
   * instead of citty's own `console.error`, which is why the root calls `runCommand`
   * rather than `runMain` — so the envelope it produces is part of the CLI's contract.
   */
  it('writes one error line to stderr and exits 1', async () => {
    setTty(false)
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as never)

    const { fail } = await import('#src/cli/io')
    expect(() => fail('something broke')).toThrow('exit 1')

    expect(written).toEqual(['error something broke\n'])
    expect(exit).toHaveBeenCalledWith(1)
  })
})

/**
 * The interactive half: `prompt`, `promptHidden` and `confirm`.
 *
 * Only the colours and `fail` were covered. These three are what `set-password` and `init`
 * run against a person, and `promptHidden` is the one that handles a password — the least
 * forgiving place for a regression, and the one that had no test at all.
 *
 * Driven through real stdin rather than by mocking readline: the point of `promptHidden` is
 * that it *suppresses echo*, which is a property of how it wires readline, and a mock would
 * assert the wiring rather than the behaviour.
 */
function feed(value: string): () => void {
  const stdin = process.stdin
  // A fresh PassThrough per call: readline closes the stream it is given.
  const fake = new PassThrough()
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true, writable: true })
  const restore = (): void => {
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true, writable: true })
  }
  setTimeout(() => fake.write(value), 0)
  return restore
}

function silenceStdout(): () => void {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  return () => write.mockRestore()
}

describe('cli io — interactive', () => {
  it('resolves a line as typed, without the newline', async () => {
    const { prompt } = await import('#src/cli/io')
    const restoreIn = feed('hello\n')
    const restoreOut = silenceStdout()
    try {
      await expect(prompt('? ')).resolves.toBe('hello')
    }
    finally {
      restoreOut()
      restoreIn()
    }
  })

  it('resolves an empty line for an empty answer', async () => {
    const { prompt } = await import('#src/cli/io')
    const restoreIn = feed('\n')
    const restoreOut = silenceStdout()
    try {
      await expect(prompt('? ')).resolves.toBe('')
    }
    finally {
      restoreOut()
      restoreIn()
    }
  })

  it('reads a hidden answer the same way, and re-prints the question as you type', async () => {
    // `promptHidden` listens for data to erase the echoed characters and put the question
    // back. With stdin not a terminal nothing echoes, but the handler still runs — and the
    // answer must come through intact.
    const { promptHidden } = await import('#src/cli/io')
    const restoreIn = feed('s3cret\n')
    const restoreOut = silenceStdout()
    try {
      await expect(promptHidden('Password: ')).resolves.toBe('s3cret')
    }
    finally {
      restoreOut()
      restoreIn()
    }
  })

  it('does not accumulate stdin listeners across repeated prompts', async () => {
    // `set-password` asks twice on one real stdin, so the handler it adds and removes must
    // not pile up. One `data` listener legitimately remains — that is readline's own, reused
    // across interfaces — so asserting zero here would assert a falsehood.
    const { promptHidden } = await import('#src/cli/io')
    const restoreOut = silenceStdout()
    try {
      const counts: number[] = []
      for (let i = 0; i < 3; i++) {
        const restoreIn = feed(`attempt-${i}\n`)
        await promptHidden('Password: ')
        counts.push(process.stdin.listenerCount('data'))
        restoreIn()
      }
      expect(counts, `listener counts across prompts: ${counts.join(', ')}`).toEqual([1, 1, 1])
    }
    finally {
      restoreOut()
    }
  })
})

describe('cli io — confirm', () => {
  /** `confirm` reads through `prompt`, so feed an answer and read the verdict. */
  async function answer(value: string, fallback: boolean): Promise<boolean> {
    const { confirm } = await import('#src/cli/io')
    const restoreIn = feed(`${value}\n`)
    const restoreOut = silenceStdout()
    try {
      return await confirm('Proceed?', fallback)
    }
    finally {
      restoreOut()
      restoreIn()
    }
  }

  it('takes an empty answer as the default, either way round', async () => {
    // This is the whole reason `confirm` exists: pressing Enter is an answer, not a no.
    expect(await answer('', true)).toBe(true)
    expect(await answer('', false)).toBe(false)
  })

  it('accepts y and yes in any case, and trims', async () => {
    for (const value of ['y', 'Y', 'yes', 'YES', 'Yes', '  y  '])
      expect(await answer(value, false), value).toBe(true)
  })

  it('treats anything else as no, including a word that merely starts with y', async () => {
    for (const value of ['n', 'no', 'N', 'nope', 'yep', 'true', '1'])
      expect(await answer(value, true), value).toBe(false)
  })

  it('shows the default in the question it asks', async () => {
    const { confirm } = await import('#src/cli/io')
    const written: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    try {
      // A fresh stdin per call: readline closes the stream it is handed, so one `feed`
      // cannot serve two prompts and the second would wait forever.
      const first = feed('\n')
      await confirm('Install now?', true)
      first()
      expect(written.join('')).toContain('[Y/n]')

      written.length = 0
      const second = feed('\n')
      await confirm('Install now?', false)
      second()
      expect(written.join('')).toContain('[y/N]')
    }
    finally {
      write.mockRestore()
    }
  })
})

describe('cli io — delay', () => {
  it('waits, and resolves to undefined', async () => {
    const { delay } = await import('#src/cli/io')
    const started = Date.now()
    await expect(delay(30)).resolves.toBeUndefined()
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
  })
})
