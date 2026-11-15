import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

/**
 * Every workspace route the router declares must be in the guard's `WORKSPACE_ROUTES`.
 *
 * A name missing from that set is not a small omission. The guard falls through to its "replace the
 * workspace" branch for a name it does not know, and an already-canonical URL is then redirected to
 * **itself** — an infinite navigation loop that locks the browser renderer. Measured on the Jobs
 * page: `DOMContentLoaded` fired, `load` never did, and Chrome stopped answering CDP reads. An empty
 * component hung identically, which is what proved the route — not the view — was the cause.
 *
 * A source check, because the failure is invisible to every other test: a unit test mounts the
 * component directly and never runs the guard.
 */
describe('the workspace route guard', () => {
  for (const ui of ['stock', 'noc-console']) {
    it(`${ui} names every workspace route in WORKSPACE_ROUTES`, () => {
      const source = fs.readFileSync(path.join(process.cwd(), 'uis', ui, 'src', 'router.ts'), 'utf8')

      const declared = [...source.matchAll(/path: '\/w\/:workspaceId[^']*',\s*name: '([^']+)'/g)].map(match => match[1]!)
      expect(declared.length, 'the routes must be parsed').toBeGreaterThanOrEqual(3)

      const guardMatch = /const WORKSPACE_ROUTES = new Set\(\[([^\]]+)\]\)/.exec(source)
      expect(guardMatch, 'WORKSPACE_ROUTES must exist').not.toBeNull()
      const guarded = new Set([...guardMatch![1]!.matchAll(/'([^']+)'/g)].map(match => match[1]!))

      const missing = declared.filter(name => !guarded.has(name))
      expect(missing, 'a missing name makes the guard redirect the page to itself').toEqual([])
    })
  }
})
