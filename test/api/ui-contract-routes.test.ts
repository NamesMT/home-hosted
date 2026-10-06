import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A route the UIs call must be named in the UI contract.
 *
 * `docs/UI_CREATION.md` says "the whole contract is this file", and its endpoint table is what a UI
 * author reads. Three families were missing entirely: `/api/ddns` (both shipped UIs call it with
 * `GET` and `PUT`), `POST`/`DELETE /api/auth/password` (both UIs reach it through the shared client),
 * and `POST /api/servers/:id/clear-logs`.
 *
 * The check reads the **shared API client**, which is what both UIs actually call, rather than either
 * UI's own module — a route only one UI uses is still part of the contract.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

describe('the UI contract route table', () => {
  it('names every route the shared client calls', () => {
    // Both halves of the surface: the shared client, and the workspace-scoped wrappers that
    // deliberately stay in each UI (`scoped()` differs per UI, so those calls do). Reading only the
    // shared module missed `/api/ddns` entirely — which is exactly the route that was undocumented.
    const sources = [
      fs.readFileSync(path.join(root, 'src/shared/api-client.ts'), 'utf8'),
      fs.readFileSync(path.join(root, 'uis/stock/src/lib/api.ts'), 'utf8'),
    ]
    const called = new Set<string>()
    for (const source of sources) {
      for (const m of source.matchAll(/scoped\(\s*[`']([^`'$]*\/api\/[^`'$]*)|request(?:<[^>]*>)?\(\s*[`']([^`'$]*\/api\/[^`'$]*)/g)) {
        const route = (m[1] ?? m[2])!
        called.add(route.replace(/\$\{[^}]*\}/g, ':id').replace(/\/+$/, ''))
      }
    }

    // Anti-vacuity: both sources must actually have been parsed.
    expect(called.size, 'the clients must name several routes').toBeGreaterThanOrEqual(20)
    expect([...called].some(r => r.startsWith('/api/ddns')), 'the scoped half must be included').toBe(true)

    const doc = fs.readFileSync(path.join(root, 'docs/UI_CREATION.md'), 'utf8')
    const undocumented = [...called].filter((route) => {
      // The doc writes `/api/servers/:id/{start,stop}` compactly, so match on the family stem.
      const stem = route.split('/').slice(0, 3).join('/')
      return !doc.includes(stem)
    })
    expect(undocumented.sort(), 'a route the UIs call that the contract never names').toEqual([])
  })
})
