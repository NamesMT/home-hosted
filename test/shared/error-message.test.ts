import { describe, expect, it } from 'vitest'
import { errorMessage } from '#src/shared/error-message'

describe('errorMessage', () => {
  it('renders an Error as its message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })

  it('renders a thrown non-Error as its text, because `catch` binds unknown', () => {
    // A child process, a native addon or a `throw 'string'` all reach a catch this way.
    expect(errorMessage('boom')).toBe('boom')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(null)).toBe('null')
    expect(errorMessage(undefined)).toBe('undefined')
  })

  it('uses the message of a subclass rather than its name', () => {
    class Detailed extends Error {
      override name = 'DetailedError'
    }
    expect(errorMessage(new Detailed('nope'))).toBe('nope')
  })
})
