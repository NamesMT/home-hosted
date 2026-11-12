import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * noc-console shows the same token table stock does.
 *
 * Tokens are named and scoped now, and a settings page that only says "API token: set" cannot answer
 * the question a person actually has — which token, with which scopes, last used when. The rendered
 * half is `uis/stock/test/tokens-section.test.ts` (stock mounts it; this UI's views pull a live
 * control plane, so its half is a source scan for the same facts).
 */
const root = fileURLToPath(new URL('..', import.meta.url))

function read(file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf8')
}

describe('noc-console and the named tokens', () => {
  const source = read('src/components/TokensSection.vue')

  it('lists a token with its scopes, its workspace limit and when it was last used', () => {
    for (const column of ['scopes', 'workspaces', 'last used'])
      expect(source, `the table must show ${column}`).toContain(column)
    expect(source, 'a limit reads as a list, or as "every workspace"').toContain('every workspace')
  })

  it('shows the value once, at creation', () => {
    expect(source).toContain('shown once')
    // The value is displayed from the mint answer, never read back from a listing.
    expect(source).toContain('minted')
  })

  it('explains each scope where it is chosen', () => {
    for (const scope of ['read', 'lifecycle', 'config', 'admin'])
      expect(source, `the ${scope} scope needs a line saying what it allows`).toContain(scope)
  })

  it('confirms a revoke instead of acting on one click', () => {
    // A revoke is irreversible: the value is not stored, so it cannot be recovered.
    expect(source).toContain('ConfirmButton')
    expect(source).toContain('cannot be restored')
  })

  it('formats a date through Intl, never by hand', () => {
    expect(source).toContain('Intl.DateTimeFormat')
  })
})
