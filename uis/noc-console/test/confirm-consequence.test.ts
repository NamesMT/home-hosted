import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A destructive confirmation must say what it destroys.
 *
 * `ConfirmButton` falls back to `` `${confirmLabel}?` `` when no `title` is given, so thirteen
 * confirmations here read only **"confirm remove?"** — the user was told a thing would be removed and
 * not what removing it costs. `ProxyView`'s retry and `GlobalSettingsView`'s clear-already showed the
 * intended shape, and the consequences were each read out of the code rather than invented: certificate
 * removal is *refused* while a route serves it (`proxy.clearCertificate`), and reverting a UI
 * `rmSync`s it rather than archiving it (`ui.revert`).
 *
 * Two exemptions are recorded rather than left to look like oversights.
 */
const root = fileURLToPath(new URL('..', import.meta.url))

/** Confirmations whose context already states the consequence. */
const CONTEXTUAL = new Map([
  ['GlobalSettingsView.vue', 'deleting a backup: the table row shows its name, size and date beside the button'],
])

/**
 * Blocks are read with a brace-aware scan rather than `[\s\S]*?\/>`: a `:title` ternary contains `>`,
 * so a non-greedy match stopped early and reported a titled button as untitled — which is how one of
 * these was nearly given redundant copy.
 */
function confirmBlocks(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8')
  const out: string[] = []
  for (let at = text.indexOf('<ConfirmButton'); at !== -1; at = text.indexOf('<ConfirmButton', at + 1)) {
    const end = text.indexOf('/>', at)
    if (end === -1)
      continue
    out.push(text.slice(at, end + 2))
  }
  return out
}

describe('destructive confirmations', () => {
  it('name the consequence, except where the surrounding row does', () => {
    const files = [...fs.readdirSync(path.join(root, 'src/views'))]
      .filter(name => name.endsWith('.vue'))
      .map(name => path.join(root, 'src/views', name))
      .concat(fs.readdirSync(path.join(root, 'src/components'), { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.vue'))
        .map(entry => path.join(root, 'src/components', entry.name)))

    const silent: string[] = []
    let total = 0
    for (const file of files) {
      if (path.basename(file) === 'ConfirmButton.vue')
        continue
      for (const block of confirmBlocks(file)) {
        if (!/:?confirm-label\s*=/.test(block))
          continue
        total += 1
        if (/:?title\s*=/.test(block) || CONTEXTUAL.has(path.basename(file)))
          continue
        silent.push(`${path.basename(file)}: ${/[^:]label="([^"]+)"/.exec(block)?.[1] ?? '?'}`)
      }
    }

    // Anti-vacuity: the views must actually hold confirmations.
    expect(total, 'expected to find several ConfirmButton uses').toBeGreaterThanOrEqual(8)
    expect(silent, 'a confirmation that states no consequence reads as "confirm remove?"').toEqual([])
  })

  it('keeps the contextual exemption to one, so another is added deliberately', () => {
    expect([...CONTEXTUAL.keys()]).toEqual(['GlobalSettingsView.vue'])
  })
})
