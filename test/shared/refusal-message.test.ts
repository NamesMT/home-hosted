import { describe, expect, it } from 'vitest'
import { refusalMessage } from '#src/shared/api-client'

/**
 * A lifecycle refusal reads as **what to do**, not as the sentence the server happened to send.
 *
 * The panel now answers `SERVER_DISABLED`, `SERVER_BUSY`, `PORT_IN_USE` and `DEPENDENCY_FAILED`
 * instead of one `ACTION_FAILED`, and each is a different fix. The UIs showed the panel's sentence
 * either way — which is honest and often enough — but a person looking at "server \"web\" is
 * disabled" still has to know that means *switch the entry on first*. This maps the code to the one
 * instruction, and falls back to the server's own text whenever it has nothing better to say.
 *
 * One function in `src/shared` because both UIs and the CLI must agree: two copies of this table is
 * how the wording drifts.
 */
describe('refusalMessage', () => {
  it.each([
    ['SERVER_DISABLED', 'switch this server on first'],
    ['SERVER_BUSY', 'a change is already in progress'],
    ['PORT_IN_USE', 'free the port, or choose another'],
    ['DEPENDENCY_FAILED', 'start the entry it depends on first'],
  ])('turns %s into what to do about it', (code, expected) => {
    expect(refusalMessage({ ok: false, code, error: 'whatever the panel said' })).toContain(expected)
  })

  it('keeps the panel sentence when the code has nothing better to say', () => {
    // The refusal's own words are the only thing that describes an unclassified failure.
    expect(refusalMessage({ ok: false, code: 'ACTION_FAILED', error: 'server "web" has no port configured' }))
      .toBe('server "web" has no port configured')
    expect(refusalMessage({ ok: false, error: 'no code at all' })).toBe('no code at all')
  })

  it('names the panel sentence beside the advice, so the two never disagree', () => {
    const message = refusalMessage({ ok: false, code: 'PORT_IN_USE', error: 'port 3000 is already in use (pid 42)' })
    expect(message).toContain('port 3000 is already in use')
    expect(message).toContain('free the port')
  })

  it('answers an empty string for a success, which is not a refusal', () => {
    expect(refusalMessage({ ok: true })).toBe('')
  })
})
