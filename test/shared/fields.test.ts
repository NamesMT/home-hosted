import { describe, expect, it } from 'vitest'
import { commaList, envToText, linesToArray, textToEnv } from '#src/shared/fields'

/**
 * The textarea round-trips both UIs' server forms read. They were byte-identical copies
 * in each UI (and had been copied again inside one of them), so a change to how a line is
 * parsed had to be made in several places and could be missed in one.
 */
describe('the server form textarea round-trips', () => {
  it('splits one entry per line, trimming and dropping blanks', () => {
    expect(linesToArray(' a \n\n  b  \n')).toEqual(['a', 'b'])
    expect(linesToArray('')).toEqual([])
  })

  it('round-trips an env map, keeping its own order', () => {
    const env = { PORT: '4000', DATA_DIR: '/tmp/x' }
    expect(envToText(env)).toBe('PORT=4000\nDATA_DIR=/tmp/x')
    expect(textToEnv(envToText(env))).toEqual(env)
  })

  it('splits an env line on the first `=` only, and trims both halves', () => {
    // A value may itself contain `=` (a connection string, a base64 blob); a line whose
    // `=` comes first names nothing and is skipped rather than stored under an empty key.
    expect(textToEnv('TOKEN=a=b=c')).toEqual({ TOKEN: 'a=b=c' })
    expect(textToEnv(' KEY = value ')).toEqual({ KEY: 'value' })
    expect(textToEnv('=nope\nNOEQUALS\nOK=1')).toEqual({ OK: '1' })
  })

  it('splits a comma-separated list, trimming and dropping blanks', () => {
    expect(commaList(' a, b ,,c ')).toEqual(['a', 'b', 'c'])
  })

  it('never lets an env key be empty, which is what `separator <= 0` guards', () => {
    expect(textToEnv('=value')).toEqual({})
    expect(Object.keys(textToEnv('=value'))).not.toContain('')
  })
})
