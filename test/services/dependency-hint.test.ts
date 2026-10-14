import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stockCopy } from '../helpers/stock-copy'

/**
 * The `dependsOn` hint must state both facts, in both UIs.
 *
 * The behaviour has two halves and each was stated somewhere while the other was missing: stock said
 * "started first, stopped last" without the **healthy** part, and `noc-console` said "started first (and
 * healthy); stopped in reverse order" — where "reverse order" is ambiguous (reverse of *what*?) and read
 * by at least one person as "the `dependsOn` list is reversed", which is backwards.
 *
 * What the code does, measured: `startDependencies` awaits `status === 'running'` **and**
 * `health !== 'unhealthy'`; `stopAll` walks `orderByDependencies(...).reverse()`, so `app -> db` stops
 * `app` then `db` — the dependency goes **last**.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

const HINTS = [
  // The stock UI translates its strings, so its hint is asserted from the catalog; `noc-console`
  // has no i18n and keeps the copy inline in its field catalogue.
  ['stock editor', null, 'serverForm.dependsOnHint'],
  ['stock dialog', null, 'serverForm.dependsOnHint'],
  ['noc-console', 'uis/noc-console/src/lib/serverForm.ts', null],
] as const

/** The hint's wording, from whichever place that UI keeps it. */
function hintText(file: string | null, key: string | null): string {
  return key === null ? fs.readFileSync(path.join(root, file!), 'utf8') : stockCopy(key)
}

describe('the dependsOn hint', () => {
  it('states that a dependency is waited for until healthy', () => {
    for (const [name, file, key] of HINTS) {
      const text = hintText(file, key)
      expect(text, `${name} must carry a hint for dependsOn`).toMatch(/started first/i)
      expect(text, `${name} must say the wait is for health`).toMatch(/healthy/i)
      expect(text, `${name} must not use the ambiguous "reverse order"`).not.toMatch(/reverse order/i)
    }
  })

  it('says the dependency is stopped last, not first', () => {
    for (const [name, file, key] of HINTS)
      expect(hintText(file, key), `${name} must say stopped last`).toMatch(/stopped last/i)
  })
})
