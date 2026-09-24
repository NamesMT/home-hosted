import { describe, expect, it } from 'vitest'
import { numberText, readNumber } from '../src/lib/numeric'

describe('readNumber', () => {
  // The regression this file exists for: `<input type="number">` hands the model
  // setter a *number*, not a string, so a field that assumed a string threw
  // `raw.trim is not a function` and silently dropped everything typed into it.
  it('accepts the number a number input reports', () => {
    expect(readNumber(4321, true)).toBe(4321)
    expect(readNumber(4321, false)).toBe(4321)
    expect(readNumber(0, false)).toBe(0)
    expect(readNumber(1.5, false)).toBe(1.5)
    expect(readNumber(-7, false)).toBe(-7)
  })

  it('accepts a string, the shape an empty or unparseable field reports', () => {
    expect(readNumber('4321', false)).toBe(4321)
    expect(readNumber(' 42 ', false)).toBe(42)
  })

  it('reads an emptied field as null when nullable, and as invalid when not', () => {
    expect(readNumber('', true)).toBeNull()
    expect(readNumber(null, true)).toBeNull()
    expect(readNumber(undefined, true)).toBeNull()
    expect(readNumber('', false)).toBeNaN()
    expect(readNumber(null, false)).toBeNaN()
  })

  it('reads anything unparseable as invalid rather than zero', () => {
    expect(readNumber('abc', false)).toBeNaN()
    expect(readNumber('abc', true)).toBeNaN()
  })
})

describe('numberText', () => {
  it('shows a real zero rather than blank', () => {
    expect(numberText(0)).toBe('0')
    expect(numberText(4321)).toBe('4321')
  })

  it('blanks what has no value to show — including NaN', () => {
    expect(numberText(null)).toBe('')
    expect(numberText(undefined)).toBe('')
    expect(numberText(Number.NaN)).toBe('')
  })
})
