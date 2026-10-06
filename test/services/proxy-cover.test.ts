import { describe, expect, it } from 'vitest'
import { coversHost } from '#src/services/proxy'

/**
 * Which hostnames a certificate covers — the rule that decides what a route serves.
 *
 * It is private to `proxy.ts` and used in **five** places (choosing the pair for a route, refusing to
 * delete one a route still serves, and reporting whether a hostname is covered at all), and it had no
 * test. A wildcard that matched more than it should is the difference between serving a certificate for
 * `example.com` and serving one for `a.b.example.com` — the browser would reject the latter, and the
 * panel would have said the hostname was covered.
 */
describe('coversHost', () => {
  it('matches an exact name, case-insensitively', () => {
    expect(coversHost(['example.com'], 'example.com')).toBe(true)
    expect(coversHost(['example.com'], 'EXAMPLE.COM')).toBe(true)
    // An exact SAN is a SAN, not a suffix: it must not cover a subdomain.
    expect(coversHost(['example.com'], 'www.example.com')).toBe(false)
  })

  it('matches a wildcard for exactly one label', () => {
    expect(coversHost(['*.example.com'], 'www.example.com')).toBe(true)
    // The bare domain is not a subdomain, so `*` does not reach it.
    expect(coversHost(['*.example.com'], 'example.com')).toBe(false)
    // Two labels deep is outside a single wildcard.
    expect(coversHost(['*.example.com'], 'a.b.example.com')).toBe(false)
  })

  it('does not let a wildcard match a lookalike domain', () => {
    // `entry.slice(1)` makes `*.example.com` into `.example.com`, so the name must *end* with it and
    // carry at least one label. Without the label check, `notexample.com` would match.
    expect(coversHost(['*.example.com'], 'notexample.com')).toBe(false)
    expect(coversHost(['*.example.com'], 'xexample.com')).toBe(false)
    expect(coversHost(['*.example.com'], 'evilexample.com')).toBe(false)
  })

  it('treats a bare `*` and an empty list as covering nothing', () => {
    // `*` does not start with `*.`, so it falls through to the exact compare and matches nothing.
    expect(coversHost(['*'], 'anything.com')).toBe(false)
    expect(coversHost([], 'x.com')).toBe(false)
  })

  it('answers true when any entry in the list covers the name', () => {
    expect(coversHost(['other.com', '*.example.com'], 'www.example.com')).toBe(true)
  })
})
