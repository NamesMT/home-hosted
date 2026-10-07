import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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
  ['stock editor', 'uis/stock/src/components/server/ServerConfigEditor.vue'],
  ['stock dialog', 'uis/stock/src/components/server/AddServerDialog.vue'],
  ['noc-console', 'uis/noc-console/src/views/ServerConfigView.vue'],
] as const

describe('the dependsOn hint', () => {
  it('states that a dependency is waited for until healthy', () => {
    for (const [name, file] of HINTS) {
      const source = fs.readFileSync(path.join(root, file), 'utf8')
      const lines = source.split('\n')
      const line = lines.find(text => /depends on/i.test(text) && /hint/.test(text))
        ?? lines.find(text => text.includes('started first'))
      expect(line, `${name} must carry a hint for dependsOn`).toBeDefined()
      expect(line, `${name} must say the wait is for health`).toMatch(/healthy/i)
      expect(line, `${name} must not use the ambiguous "reverse order"`).not.toMatch(/reverse order/i)
    }
  })

  it('says the dependency is stopped last, not first', () => {
    for (const [name, file] of HINTS) {
      const source = fs.readFileSync(path.join(root, file), 'utf8')
      expect(source, `${name} must say stopped last`).toMatch(/stopped last/i)
    }
  })
})
