import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The same field must not be described two ways in one UI.
 *
 * `AddServerDialog` (first-time setup) and `ServerConfigEditor` (the config-file view) edit the same
 * form, and three hints on shared labels said the same thing twice: `Enabled` was "Shows up and can be
 * started at all" in one and "Off keeps the entry in the config but refuses to start it" in the other,
 * `Autostart with up` and `Port` likewise. The vaguer wording won wherever a reader happened to look
 * first, and nothing caught it because both are valid copy.
 *
 * Labels whose hints are **deliberately different facts** are listed below rather than forced together:
 * each place tells half the story, and merging them would bloat both.
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const DIALOG = path.join(root, 'src/components/server/AddServerDialog.vue')
const EDITOR = path.join(root, 'src/components/server/ServerConfigEditor.vue')

/** Labels whose two hints carry different information on purpose. */
const COMPLEMENTARY = new Map([
  ['Arguments', 'the dialog explains that whitespace is preserved; the editor lists the placeholders'],
  ['Bind address', 'the dialog warns about exposure; the editor explains when a custom IPv4 stays selectable'],
  ['Run a bootstrap', 'the dialog says what a bootstrap is for; the editor says what `off` writes'],
])

function hintsByLabel(file: string): Map<string, string> {
  const text = fs.readFileSync(file, 'utf8')
  const out = new Map<string, string>()
  for (const m of text.matchAll(/label="([^"]+)"[^>]*?hint="([^"]+)"/g))
    out.set(m[1]!, m[2]!)
  for (const m of text.matchAll(/hint="([^"]+)"[^>]*?label="([^"]+)"/g))
    out.set(m[2]!, m[1]!)
  return out
}

describe('field hints', () => {
  it('describes a shared field the same way in both places', () => {
    const dialog = hintsByLabel(DIALOG)
    const editor = hintsByLabel(EDITOR)
    // Anti-vacuity: both files must actually carry labelled hints.
    expect(dialog.size).toBeGreaterThan(15)
    expect(editor.size).toBeGreaterThan(12)

    const divergent = [...dialog.keys()]
      .filter(label => editor.has(label) && editor.get(label) !== dialog.get(label))
      .filter(label => !COMPLEMENTARY.has(label))

    expect(divergent, 'a shared label with two hints means one of them is the vaguer duplicate').toEqual([])
  })

  it('keeps the documented exceptions to three, so one is added deliberately', () => {
    const dialog = hintsByLabel(DIALOG)
    const editor = hintsByLabel(EDITOR)
    const actuallyDifferent = [...dialog.keys()]
      .filter(label => editor.has(label) && editor.get(label) !== dialog.get(label))
    expect(actuallyDifferent.sort()).toEqual([...COMPLEMENTARY.keys()].sort())
  })
})
