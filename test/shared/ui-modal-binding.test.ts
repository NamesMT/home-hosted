import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

/**
 * A `<Modal>` must be opened with `v-model:open`, never `:open` plus a handler.
 *
 * `Modal` declares `defineModel('open')`, so it emits `update:open` as it **opens**. Binding `:open`
 * and reacting to `update:open` therefore resets the caller's flag to false on the way in: the sheet
 * renders in the closed state (measured — clipped at the left edge with its labels cut off), and a
 * successful submit leaves it on screen with empty fields while the row it created is already in the
 * table. Nothing throws, and a unit test that mounts the page never opens the dialog.
 *
 * A source check, for the same reason as the route-guard one: the failure is a rendering state no
 * assertion in a headless mount exercises.
 */
describe('the Modal binding', () => {
  it('opens with v-model:open in every view', () => {
    const roots = ['stock', 'noc-console'].map(ui => path.join(process.cwd(), 'uis', ui, 'src'))
    const offenders: string[] = []
    for (const root of roots) {
      for (const file of filesUnder(root)) {
        const source = fs.readFileSync(file, 'utf8')
        for (const match of source.matchAll(/<Modal\b[^>]*>/g)) {
          const tag = match[0]
          // A tag that binds `:open` (not `v-model:open`) is the defect; `Modal` owns the state.
          if (/(?<!v-model):open=/.test(tag))
            offenders.push(`${path.relative(process.cwd(), file)}: ${tag.replace(/\s+/g, ' ').slice(0, 80)}`)
        }
      }
    }
    expect(offenders, 'a Modal needs v-model:open; :open is reset by its own update event').toEqual([])
  })
})

/** Every .vue under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory())
      out.push(...filesUnder(full))
    else if (entry.name.endsWith('.vue'))
      out.push(full)
  }
  return out
}
