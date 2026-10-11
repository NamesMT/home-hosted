import { describe, expect, it } from 'vitest'
import { envToText, linesToArray, textToEnv } from '../src/lib/fields'

/**
 * The textarea round-trips, which both entry points used to inline.
 *
 * They were two byte-identical copies of `linesToArray`/`textToEnv` (and a third of
 * `envToText` in the page alone), so a change to how a line is parsed had to be made
 * twice and could be missed once. These pin the parse both forms now share.
 */
describe('the shared textarea conversions', () => {
  it('trims both sides of a KEY=value pair and drops blank lines', () => {
    expect(textToEnv(' A = 1 \n\nB=2\n')).toEqual({ A: '1', B: '2' })
  })

  it('drops a line that names no key, rather than storing it under an empty one', () => {
    // `separator <= 0` is the guard: a line with no `=` and a line starting with one both
    // name nothing, and an empty key is not what the config stores.
    expect(textToEnv('=x\nno-separator\nK=v')).toEqual({ K: 'v' })
  })

  it('trims each list entry and drops the blank ones', () => {
    expect(linesToArray(' a \n\n b ')).toEqual(['a', 'b'])
    expect(linesToArray('')).toEqual([])
  })

  it('round-trips an env map through the textarea', () => {
    const env = { DATA_DIR: '{home}/.app', PORT: '3000' }
    expect(textToEnv(envToText(env))).toEqual(env)
  })

  it('keeps the value’s own `=` signs and inner spaces', () => {
    // Only the first `=` separates: a base64 or a query string must survive verbatim.
    expect(textToEnv('TOKEN=a=b=c')).toEqual({ TOKEN: 'a=b=c' })
  })
})
