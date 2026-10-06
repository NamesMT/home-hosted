import { describe, expect, it } from 'vitest'
import { nearestWord } from '#src/cli/nearest'

/**
 * The command a typo meant, or null.
 *
 * `SYNOPSIS` is the candidate source, so a suggestion can only ever name a command the CLI actually
 * has. The threshold is the other half: naming an unrelated command is worse than naming none, so a
 * far-off word must get nothing. The candidate list is a parameter, which is what lets this be tested
 * without reaching into the CLI's internals.
 */
describe('nearestWord', () => {
  const real = ['up', 'down', 'restart', 'status', 'logs', 'start', 'stop']

  it('names the command a near miss meant', () => {
    expect(nearestWord('restar', real)).toBe('restart')
    expect(nearestWord('stats', real)).toBe('status')
    expect(nearestWord('dwn', real)).toBe('down')
    // A trailing character, and the case-insensitive form.
    expect(nearestWord('logs2', real)).toBe('logs')
    expect(nearestWord('UP', real)).toBe('up')
  })

  it('says nothing when nothing is close', () => {
    for (const input of ['zebra', 'config', 'helpme', 'zzz', '', 'x'])
      expect(nearestWord(input, real), input).toBeNull()
  })

  it('only ever returns a name from the candidate list', () => {
    for (const input of ['upx', 'statsu', 'stopp', 'log', 'nonsense']) {
      const suggestion = nearestWord(input, real)
      // `null` is the honest answer for a word that is not close; anything else must be a real name.
      if (suggestion !== null)
        expect(real, `${input} suggested ${suggestion}`).toContain(suggestion)
    }
    // Anti-vacuity: at least one of those does produce a suggestion, so the loop is not a no-op.
    expect(['upx', 'statsu', 'stopp', 'log'].some(i => nearestWord(i, real) !== null)).toBe(true)
  })

  it('is empty-safe when there are no candidates', () => {
    expect(nearestWord('up', [])).toBeNull()
  })
})
