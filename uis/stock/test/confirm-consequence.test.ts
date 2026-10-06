import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A destructive confirmation must say what it destroys.
 *
 * `ConfirmButton` falls back to `` `${confirmLabel}?` `` when no `title` is given, so four of the five
 * destructive actions read only **"Confirm remove?"** — the user was told a thing would be removed and
 * not what removing it costs (`Clear password` also switches authentication off; `Remove certificate`
 * rebinds the listener onto http). `DdnsSection` already showed the intended shape: a title naming the
 * act and a hint naming the cost.
 *
 * `Delete` on a backup is the one exemption: the row shows the archive's name, size and date beside the
 * button, so "Confirm delete" is unambiguous in context. Recorded here rather than left to look like an
 * oversight.
 */
const root = fileURLToPath(new URL('..', import.meta.url))

/** Files whose destructive confirmation needs only the default title, with the reason. */
const CONTEXTUAL = new Map([
  ['BackupsSection.vue', 'the row already shows the archive name, size and date beside the button'],
])

function confirmButtons(file: string): Array<{ label: string, hasTitle: boolean, hasHint: boolean }> {
  const text = fs.readFileSync(file, 'utf8')
  const out: Array<{ label: string, hasTitle: boolean, hasHint: boolean }> = []
  for (const m of text.matchAll(/<ConfirmButton[\s\S]{0,900}?\/>/g)) {
    const block = m[0]
    const label = /[^:]label="([^"]+)"/.exec(block)?.[1]
    if (label === undefined)
      continue
    out.push({ label, hasTitle: /:?title=/.test(block), hasHint: /:?hint=/.test(block) })
  }
  return out
}

describe('destructive confirmations', () => {
  it('name the consequence, except where the row already does', () => {
    const files = [...fs.readdirSync(path.join(root, 'src/components/settings'))]
      .filter(name => name.endsWith('.vue') && name !== 'ConfirmButton.vue')

    const silent: string[] = []
    let destructive = 0
    for (const name of files) {
      for (const button of confirmButtons(path.join(root, 'src/components/settings', name))) {
        destructive += 1
        if (button.hasTitle || CONTEXTUAL.has(name))
          continue
        silent.push(`${name}: ${button.label}`)
      }
    }

    // Anti-vacuity: the directory must actually hold destructive confirmations.
    expect(destructive, 'expected to find several ConfirmButton uses').toBeGreaterThanOrEqual(4)
    expect(silent, 'a confirmation that states no consequence reads as "Confirm remove?"').toEqual([])
  })

  it('keeps the contextual exemption to one, so another is added deliberately', () => {
    expect([...CONTEXTUAL.keys()]).toEqual(['BackupsSection.vue'])
  })
})
