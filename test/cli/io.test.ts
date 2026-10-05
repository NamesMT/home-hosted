import process from 'node:process'
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
