/**
 * A plain object, and nothing else: not `null`, and not an array.
 *
 * Every untyped boundary here narrows to this shape, and it lived as **nine** definitions across
 * `src/` and the UIs: seven strict (one an inline ternary rather than a named function, which is why
 * a search for the name found only some of them) and two — both UIs' `lib/api.ts` — that accepted an
 * array.
 *
 * The `!Array.isArray` half is the one that matters: `typeof [] === 'object'` is true, so without
 * it an array narrows to a record and reading a property off it silently yields `undefined`
 * instead of failing — and iterating it with `Object.entries` yields the *indices*.
 *
 * The two loose copies happened to behave the same on the payloads they see, but only by accident
 * of which properties they read. They use this one now, so the next reader does not have to work
 * that out.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
