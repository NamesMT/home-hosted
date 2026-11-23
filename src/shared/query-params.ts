import { type } from 'arktype'
import { lazy } from './lazy'

/**
 * The three kinds of query value, declared once.
 *
 * A query string is text, so every schema over it is text too — which is how `?logs=false` kept the
 * logs (only the literal `'0'` dropped them), `stop-all?withPersistent=1` meant *false* (`===
 * 'true'`), and `?tail=abc` fell back to the default rather than refusing. Each route then re-derived
 * the same value in its handler, so the meaning of a flag was written as often as it was read.
 *
 * These schemas parse at the boundary instead: a flag is one of four accepted spellings and becomes
 * a **boolean**, a count is a whole number inside its stated bounds or a `400 INVALID_INPUT`, and a
 * handler receives the value it already means. Anything else is refused — a client that typed
 * `?logs=no` gets told, rather than getting the opposite of what it asked for.
 *
 * `'0'`/`'1'` are accepted beside `'true'`/`'false'` because they are what a shell and a
 * `URLSearchParams` caller reach for; `yes`/`no`/`on`/`off` are not, deliberately — a spelling outside
 * this list is a client bug, and a permissive parser turns it into a silent default.
 */

/** A flag: `0`, `1`, `true` or `false`, parsed to a boolean. */
export const booleanParam = lazy(() => type('"0" | "1" | "true" | "false"').pipe(value => value === '1' || value === 'true'))

/**
 * A count: a whole decimal integer within `min`–`max`, parsed to a number.
 *
 * `string.integer.parse` refuses a fraction, an exponent, `+3` and surrounding space, so `tail=1.5`
 * and `limit=-1` never reach a `Math.min`/`Math.max` pair that would have quietly accepted them.
 * The bounds belong to the route: a value outside them is a mistake in the call, not something to
 * clamp, because clamping answers a different question than the one asked.
 */
export function integerParam(min: number, max: number) {
  return lazy(() => type('string.integer.parse').pipe(type(`${min} <= number <= ${max}`)))
}
