import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A link to a path no route declares is a dead end, and it fails *silently*.
 *
 * Every workspace page lives under `/w/:workspaceId/...`. Four components still linked to the
 * pre-workspace `/servers/<id>`, which matches only the catch-all — so clicking a server card
 * rendered the global overview, and the URL the page showed was the wrong one to begin with.
 * Nothing type-checked it: `RouterLink :to` takes a string.
 */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const repoRoot = path.resolve(root, '..', '..')

/** The file kinds that can hold a link; a regex literal inside `.test()` trips the lint. */
const SOURCE_FILE = /\.(?:vue|ts)$/

/** Every `.vue`/`.ts` under a UI's `src`, so a new component is covered without being listed. */
function sources(ui: string): string[] {
  const base = path.join(repoRoot, 'uis', ui, 'src')
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && SOURCE_FILE.test(entry.name))
    .map(entry => path.join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name))
}

/** The first paths a route table declares, so a link can be checked against it. */
function declaredPaths(ui: string): string[] {
  const text = readFileSync(path.join(repoRoot, 'uis', ui, 'src', 'router.ts'), 'utf8')
  return [...text.matchAll(/path:\s*'([^']+)'/g)].map(match => match[1]!)
}

/** A `to` that is a plain literal starting with `/` — the shape that can be checked statically. */
/** Only targets that *start with a slash* — a `workspacePath(...)` call is the correct form. */
const LITERAL_TO = /:to="`?(\/[^`"]*)`?"/g

describe('route links', () => {
  for (const ui of ['stock', 'noc-console']) {
    it(`${ui}: every literal link matches a declared path or a builder`, () => {
      const routes = declaredPaths(ui)
      // A declared path with a param is matched by shape, not by literal equality.
      const isDeclared = (target: string): boolean => {
        if (target.startsWith('/w/'))
          return true // workspace pages are built by `workspacePath`, which owns the shape
        return routes.some((route) => {
          if (route === target)
            return true
          // `/proxy` vs `/proxy/...`, and a param route written as `:id`.
          const pattern = new RegExp(`^${route.replace(/:[^/]+/g, '[^/]+').replace(/\*/g, '.*')}$`)
          return pattern.test(target)
        })
      }

      const offenders: string[] = []
      for (const file of sources(ui)) {
        const text = readFileSync(file, 'utf8')
        for (const match of text.matchAll(LITERAL_TO)) {
          const target = match[1]!
          // An interpolated target is fine when it interpolates the workspace segment itself
          // (`/w/${id}/logs`); what broke was a bare per-server path with no workspace at all.
          if (target.startsWith('/w/'))
            continue
          if (target.includes('${'))
            offenders.push(`${path.relative(repoRoot, file)}: ${match[0]} — no workspace segment; use workspacePath()`)
          else if (!isDeclared(target))
            offenders.push(`${path.relative(repoRoot, file)}: ${match[0]} — no route declares it`)
        }
      }
      expect(offenders).toEqual([])
    })
  }
})
