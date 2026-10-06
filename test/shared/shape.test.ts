import { describe, expect, it } from 'vitest'
import { isRecord } from '#src/shared/shape'

/**
 * One predicate for every untyped boundary, after eight private copies.
 *
 * The array case is the reason this needs its own test: `typeof [] === 'object'` is true, so
 * without `!Array.isArray` an array narrows to a record — and the callers then read properties off
 * it (getting `undefined` instead of a failure) or iterate it with `Object.entries`, which yields
 * the *indices*. Two of the eight copies had exactly that hole; it was unobservable on the payloads
 * they saw, which is why nothing caught it.
 */
describe('isRecord', () => {
  it('accepts a plain object', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
  })

  it('refuses an array, which `typeof` calls an object', () => {
    expect(isRecord([])).toBe(false)
    expect(isRecord([{ a: 1 }])).toBe(false)
  })

  it('refuses null and the non-objects', () => {
    for (const value of [null, undefined, 0, '', 'x', true, false, () => {}, Symbol('s'), 1n])
      expect(isRecord(value), `"${String(value)}" must not be a record`).toBe(false)
  })

  it('narrows to a record rather than a bare object', () => {
    const value: unknown = { key: 'v' }
    expect(isRecord(value)).toBe(true)
    // The point of the predicate: this compiles only because it narrowed.
    expect(isRecord(value) && Object.keys(value)).toEqual(['key'])
  })
})
