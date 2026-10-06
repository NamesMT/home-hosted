import { describe, expect, it } from 'vitest'
import { secretEqual } from '#src/helpers/secret-compare'

/**
 * The shared secret comparison, used by the `/_hh` control channel and the ACME challenge route.
 *
 * Both places take a secret straight off a header and act on it, and the `/_hh` channel is
 * deliberately outside `/api` — the token is the only thing guarding it. `!==` short-circuits at the
 * first differing byte, so a local user could recover a token by timing.
 *
 * **What these tests cannot do:** assert constant timing. That is not stably measurable in a unit test,
 * and a flaky timing assertion is worse than none — so the constant-time property rests on the
 * implementation using `timingSafeEqual`, not on a test. What is pinned here is the surrounding
 * contract: exact-match semantics, no throw on a length mismatch, multi-byte safety, and the empty
 * string never matching.
 */
describe('secretEqual', () => {
  it('accepts only exact matches', () => {
    expect(secretEqual('hh_abc123', 'hh_abc123')).toBe(true)
    expect(secretEqual('hh_abc124', 'hh_abc123')).toBe(false)
    expect(secretEqual('hh_abc12', 'hh_abc123'), 'prefix is not a match').toBe(false)
    expect(secretEqual('hh_abc1234', 'hh_abc123')).toBe(false)
    expect(secretEqual('', 'hh_abc123')).toBe(false)
    expect(secretEqual('hh_abc123', '')).toBe(false)
  })

  it('refuses a mismatch wherever it differs', () => {
    const secret = 'hh_0123456789abcdefghij'
    const early = `X${secret.slice(1)}`
    const late = `${secret.slice(0, -1)}X`
    expect(secretEqual(early, secret)).toBe(false)
    expect(secretEqual(late, secret)).toBe(false)
    expect(early.length, 'same length, so length alone is not what differs').toBe(secret.length)
    expect(late.length).toBe(secret.length)
  })

  it('never matches an empty secret', () => {
    // A missing or blank header must not authorise anything. This is also the case that catches a
    // naive `a === b` replacement, which would accept two empty strings.
    expect(secretEqual('', '')).toBe(false)
    expect(secretEqual('', 'any-secret')).toBe(false)
  })

  it('does not throw on a length mismatch, which timingSafeEqual alone would', () => {
    // A truncated header must be a refusal, not a 500.
    expect(() => secretEqual('short', 'a-much-longer-expected-secret')).not.toThrow()
  })

  it('handles multi-byte input without splitting a character', () => {
    expect(secretEqual('héllo', 'héllo')).toBe(true)
    expect(secretEqual('héllo', 'hello')).toBe(false)
  })
})
