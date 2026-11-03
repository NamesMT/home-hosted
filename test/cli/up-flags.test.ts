import { describe, expect, it, vi } from 'vitest'
import { alreadyRunningConflict, toUpFlags } from '#src/cli/up'

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

/**
 * `up` on a live panel reports "already running" and exits 0, which is right for its most common
 * use — "make sure it is running". The flags are a different matter: `--port`, `--host` and
 * `--open` were parsed, then dropped on that path, so `up --port 4800` against a panel on 3999
 * printed a success line and exited 0 without moving anything. Measured on the built CLI with a
 * panel live on 6611: `up --port 4800` exited 0 and the panel stayed on 6611.
 *
 * AGENTS.md already settled the direction — "a flag the command cannot honour is refused" — and
 * `restart --workspace <id>` with no server id exits 1 for the same reason. These pin the sentence
 * rather than a spawned daemon, because the decision is pure: the flags, the live record, and the
 * answer.
 */
describe('up on a running panel', () => {
  const runtime = { url: 'http://127.0.0.1:3999', port: 3999 }
  const flags = { autostart: true, open: false, foreground: false, printConfig: false } as const

  it('says nothing when the flags agree with the live panel', () => {
    // `up` alone, `up --port <the port it is on>`, and `--no-autostart` are all honoured: the first
    // two ask for the state that exists, and the third asks for nothing at all on this path.
    expect(alreadyRunningConflict({ ...flags }, runtime)).toBeNull()
    expect(alreadyRunningConflict({ ...flags, port: 3999 }, runtime)).toBeNull()
    expect(alreadyRunningConflict({ ...flags, autostart: false }, runtime)).toBeNull()
  })

  it('names a flag the live panel contradicts, and what to do about it', () => {
    for (const [asked, expected] of [
      [{ port: 4800 }, '--port 4800 was not honoured'],
      [{ host: 'lan' }, '--host lan was not honoured'],
      [{ open: true }, '--open was not honoured'],
    ] as const) {
      const sentence = alreadyRunningConflict({ ...flags, ...asked }, runtime)
      expect(sentence, `${JSON.stringify(asked)} must be refused`).not.toBeNull()
      expect(sentence).toContain(expected)
      // The real URL, so the person knows where the panel actually is rather than only that
      // their flag was ignored.
      expect(sentence).toContain(runtime.url)
    }
  })

  it('pluralises several dropped flags, and lists each one', () => {
    const sentence = alreadyRunningConflict({ ...flags, port: 4800, host: 'lan', open: true }, runtime)
    expect(sentence).toContain('--port 4800 and --host lan and --open were not honoured')
  })

  it('does not invent a conflict for a flag it cannot see', () => {
    // `--no-autostart` is a wish about a boot this command is not performing: the panel has already
    // booted, so there is nothing to honour or refuse. Refusing it would break `up --no-autostart`
    // in a retry loop, which is the one spelling a script uses to keep its hands off the entries.
    expect(alreadyRunningConflict({ ...flags, autostart: false }, runtime)).toBeNull()
  })
})
