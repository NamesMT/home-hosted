import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The builders in `services/state.ts` must stay reachable, or go.
 *
 * One builder was a one-line passthrough called from the state frame. The workspaces refactor
 * replaced that call with a direct `hostMonitor.view` read and left the function behind — still
 * `export`ed, still typed, referenced by nothing, for several releases. Nothing caught it: an unused
 * export is invisible to the typechecker and to ESLint's unused-import rule (checked:
 * `unused-imports/no-unused-imports` is on, and it does not see exports), and no test named it because
 * there was nothing to test.
 *
 * This is deliberately a *reachability* check on one file rather than a repo-wide dead-code scan: a
 * scan over every export produced ~230 candidates of which nearly all were false positives (schemas
 * built in their own module, CLI entries loaded by dynamic `import()`, helpers used within their file).
 * A guard that noisy gets disabled, so this pins only what it can prove.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

function source(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

/** Every `.ts`/`.vue` under the repo, minus build output and dependencies. */
function searchableFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'coverage', '.git'].includes(entry.name))
        continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory())
        walk(full)
      else if (/\.(?:ts|vue)$/.test(entry.name))
        out.push(full)
    }
  }
  walk(root)
  return out
}

describe('state builders', () => {
  it('has no builder that nothing references', () => {
    const files = searchableFiles()
    // Anti-vacuity: the walk must actually see the tree.
    expect(files.length).toBeGreaterThan(60)

    // Comments are stripped first: this file's own prose named one of the builders, which counted as
    // a use and made the guard pass on the very orphan it was written to catch.
    const deComment = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '')
    const bodies = files.map(file => ({ rel: path.relative(root, file).replaceAll('\\', '/'), text: deComment(fs.readFileSync(file, 'utf8')) }))
    const state = deComment(source('src/services/state.ts'))
    const builders = [...state.matchAll(/^export function (build\w+)\(/gm)].map(m => m[1]!)
    // The file is meant to build views; an empty list would make this pass for the wrong reason.
    expect(builders.length, 'expected several builders').toBeGreaterThanOrEqual(3)

    const orphans = builders.filter((name) => {
      const uses = bodies
        .filter(file => file.rel !== 'src/services/state.ts')
        .reduce((total, file) => total + [...file.text.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length, 0)
      // Also count a use *inside* the file, since one builder may call another.
      const insideOwnBody = [...state.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length
      return uses === 0 && insideOwnBody === 1
    })

    expect(orphans, 'a builder with no caller is dead code, not an API').toEqual([])
  })
})
