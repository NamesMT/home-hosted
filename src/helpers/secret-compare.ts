import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * `a !== b` short-circuits at the first differing byte, so an attacker who can measure response time
 * recovers a secret one byte at a time. That matters wherever the secret is the *only* thing standing
 * between a caller and a privileged action — the `/_hh` control channel, which is deliberately outside
 * `/api` and guarded by nothing else.
 *
 * Length is compared first because `timingSafeEqual` **throws** on differing lengths. That leaks only
 * the length, which is not secret here (the token has a fixed shape and a `hh_` prefix); rejecting it
 * is what keeps a truncated header from becoming a 500.
 */
export function secretEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length || left.length === 0)
    return false
  return crypto.timingSafeEqual(left, right)
}
