import { describe, expect, it, vi } from 'vitest'
import { toUpFlags } from '#src/cli/up'

/**
 * `--port` must be the port the caller typed, or a refusal.
 *
 * The range check was already there; what it could not catch was `Number.parseInt`'s prefix
 * behaviour, so a *partial* parse arrived as an in-range number:
 *
 *     --port 1e3    -> 1      (privileged, and not what anyone typed)
 *     --port 8000x  -> 8000   (right by accident)
 *
 * Both are silent. A listener on the wrong port is the kind of failure that looks like success
 * until something cannot reach it, so the whole argument now has to be a decimal integer.
 */
describe('up --port', () => {
  const port = (raw: string): number | undefined => {
    // `fail()` ends the process; intercept it so the assertion can read the refusal.
    const spy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('refused') }) as never)
    try {
      return toUpFlags({ port: raw } as never).port
    }
    finally {
      spy.mockRestore()
    }
  }

  it('refuses a partly numeric port instead of reading its prefix', () => {
    for (const raw of ['1e3', '8000x', '0x1F90', '80.5', 'abc', '-1', '', '65536'])
      expect(() => port(raw), `--port ${raw} was accepted`).toThrow()
  })

  it('accepts a real port, including the boundaries and surrounding space', () => {
    expect(port('8080')).toBe(8080)
    expect(port('  8080  ')).toBe(8080)
    expect(port('1')).toBe(1)
    expect(port('65535')).toBe(65535)
  })

  it('leaves the port unset when the flag is absent', () => {
    expect(toUpFlags({} as never).port).toBeUndefined()
  })
})
