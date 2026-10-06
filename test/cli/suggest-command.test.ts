import { describe, expect, it } from 'vitest'
import { suggestCommand } from '../../src/cli'

/**
 * The command a typo meant, or null.
 *
 * `SYNOPSIS` is the candidate source, so a suggestion can only ever name a command the CLI actually
 * has. The threshold is the other half: naming an unrelated command is worse than naming none, so a
 * far-off word must get nothing. The candidate list is a parameter, which is what lets this be tested
 * without reaching into the CLI's internals.
 */
describe('suggestCommand', () => {
  const real = ['up', 'down', 'restart', 'status', 'logs', 'start', 'stop']

  it('names the command a near miss meant', () => {
    expect(suggestCommand('restar', real)).toBe('restart')
    expect(suggestCommand('stats', real)).toBe('status')
    expect(suggestCommand('dwn', real)).toBe('down')
    // A trailing character, and the case-insensitive form.
    expect(suggestCommand('logs2', real)).toBe('logs')
    expect(suggestCommand('UP', real)).toBe('up')
  })

  it('says nothing when nothing is close', () => {
    for (const input of ['zebra', 'config', 'helpme', 'zzz', '', 'x'])
      expect(suggestCommand(input, real), input).toBeNull()
  })

  it('only ever returns a name from the candidate list', () => {
    for (const input of ['upx', 'statsu', 'stopp', 'log', 'nonsense']) {
      const suggestion = suggestCommand(input, real)
      // `null` is the honest answer for a word that is not close; anything else must be a real name.
      if (suggestion !== null)
        expect(real, `${input} suggested ${suggestion}`).toContain(suggestion)
    }
    // Anti-vacuity: at least one of those does produce a suggestion, so the loop is not a no-op.
    expect(['upx', 'statsu', 'stopp', 'log'].some(i => suggestCommand(i, real) !== null)).toBe(true)
  })

  it('is empty-safe when there are no candidates', () => {
    expect(suggestCommand('up', [])).toBeNull()
  })
})
