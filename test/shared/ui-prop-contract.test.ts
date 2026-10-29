import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The two UIs' `ConfirmButton` are one component in two copies, so they take the same props.
 *
 * `uis/stock`'s `DestinationsSection` passed `:question` and `:body` to its copy, which declares
 * `title` and `hint` — the names `noc-console`'s copy uses. Vue puts an undeclared prop in `$attrs`
 * without a word: the popover asked only **"Confirm remove?"**, and the two strings written for it
 * (`settings.destination.removeBody`, `settings.telegram.removeTokenHint`) were rendered nowhere.
 * `confirm-consequence.test.ts` reads the same buttons from the other side — it asks whether a
 * `title` is *present* — so the wrong name read as "untitled" and was then excused by the
 * contextual exemption. Typechecking cannot see it either: the caller is a template.
 *
 * A general "every bound prop is declared" scan was written first and thrown away: Vue forwards an
 * undeclared attribute to the component's root element, so a component with a native root accepts
 * any name at all and the scan reported 260 legitimate uses. What is checkable is the pair — two
 * copies of one component, and the call sites that must satisfy both.
 */

/** The props a component declares, from its `defineProps<{...}>()` block. */
function declaredProps(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8')
  const block = /(?:withDefaults\()?defineProps<\{([\s\S]*?)\}>\(\)/.exec(text)
  const declared = block === null ? [] : [...block[1]!.matchAll(/^\s{2}(\w+)\??:/gm)].map(match => match[1]!)
  // A `defineModel('x')` is a prop too, and it is declared outside the props block.
  const models = [...text.matchAll(/defineModel<[^>]*>\('(\w+)'/g)].map(match => match[1]!)
  return [...new Set([...declared, ...models])].sort()
}

const confirmButton = (ui: string): string => path.join(root, 'uis', ui, 'src', 'components', ui === 'stock' ? 'settings/ConfirmButton.vue' : 'ConfirmButton.vue')

/** Every attribute bound on a `<ConfirmButton>` in one UI, camelCased the way Vue reads it. */
function boundOnConfirmButton(ui: string): Array<{ file: string, prop: string }> {
  const out: Array<{ file: string, prop: string }> = []
  for (const entry of fs.readdirSync(path.join(root, 'uis', ui, 'src'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.vue') || entry.name === 'ConfirmButton.vue')
      continue
    const file = path.join(entry.parentPath, entry.name)
    const template = fs.readFileSync(file, 'utf8').slice(fs.readFileSync(file, 'utf8').indexOf('<template>'))
    for (const tag of template.matchAll(/<ConfirmButton\b[^>]*>/g)) {
      for (const attribute of tag[0].matchAll(/(?:^|\s)(:\w+|v-model:\w+|\w[\w-]*)=/g)) {
        const name = attribute[1]!
        if (name.startsWith('@'))
          continue
        const prop = name.replace(/^:/, '').replace(/^v-model:/, '').replace(/-([a-z0-9])/g, (_all, letter: string) => letter.toUpperCase())
        // `v-if`/`v-for`/`key`/`class` are Vue's, not the component's.
        if (/^v[A-Z]/.test(prop) || ['key', 'class', 'style', 'ref'].includes(prop))
          continue
        out.push({ file: path.relative(root, file).replaceAll('\\', '/'), prop })
      }
    }
  }
  return out
}

describe('the two ConfirmButton copies take the same props', () => {
  it('declares one prop set in both UIs', () => {
    const stock = declaredProps(confirmButton('stock'))
    const noc = declaredProps(confirmButton('noc-console'))
    // Anti-vacuity: both blocks must be readable, and they must be more than a label.
    expect(stock.length, 'stock ConfirmButton props').toBeGreaterThanOrEqual(5)
    expect(noc.length, 'noc-console ConfirmButton props').toBeGreaterThanOrEqual(5)
    // `variant`/`size` vs `tone` is the one honest difference: the two UIs have different buttons.
    const shared = ['label', 'confirmLabel', 'disabled', 'title', 'hint', 'alternativeLabel']
    for (const prop of shared)
      expect({ prop, stock: stock.includes(prop), noc: noc.includes(prop) }, `${prop} must exist in both`).toEqual({ prop, stock: true, noc: true })
  })

  it('binds no prop name its own copy does not declare', () => {
    const offenders: string[] = []
    for (const ui of ['stock', 'noc-console'] as const) {
      const declared = declaredProps(confirmButton(ui))
      for (const { file, prop } of boundOnConfirmButton(ui)) {
        if (!declared.includes(prop))
          offenders.push(`${file}: \`${prop}\` is not a ${ui} ConfirmButton prop (${declared.join(', ')})`)
      }
    }
    expect(offenders).toEqual([])
  })

  /** Anti-vacuity: the call sites are what the check above actually reads. */
  it('finds the call sites to check', () => {
    for (const ui of ['stock', 'noc-console'] as const)
      expect(boundOnConfirmButton(ui).length, `${ui} ConfirmButton call sites`).toBeGreaterThan(5)
  })
})
