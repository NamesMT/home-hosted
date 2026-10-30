import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { templateRegion } from '../../../test/helpers/strip-comments'
import { openingTags } from '../../../test/helpers/template-render'

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
 * Each opening tag, attributes alone: a `:title` ternary contains `>`, so `[\s\S]*?\/>` stopped at
 * the wrong place, and a `/>`-only matcher read a paired `<ConfirmButton …></ConfirmButton>` as no
 * button at all — measured green on a confirmation whose `title` had been dropped.
 */
function confirmBlocks(file: string): string[] {
  return openingTags(templateRegion(fs.readFileSync(file, 'utf8')), 'ConfirmButton')
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

  /**
   * The other half: a destructive action that is **not** a `ConfirmButton` at all.
   *
   * The scan above only reads `ConfirmButton` uses, so it cannot notice one that should exist and
   * does not — `SettingsView` shipped "remove destination" and "remove token" as plain buttons
   * during the notifications restructure and both tests stayed green. This finds a plain button
   * whose label is destructive and whose block carries no confirmation.
   */
  it('has no destructive plain button where a confirmation belongs', () => {
    const views = fs.readdirSync(path.join(root, 'src/views')).filter(name => name.endsWith('.vue'))
    const plainDestructive = /<button[^>]*>\s*(?:remove|delete|forget|revoke|clear|disable)[^<]*<\/button>/i

    const offenders = views
      .filter(name => plainDestructive.test(fs.readFileSync(path.join(root, 'src/views', name), 'utf8')))
      .map(name => `src/views/${name}`)

    expect(offenders, 'a destructive action one click away must confirm in a popover').toEqual([])
  })

  it('keeps the contextual exemption to one, so another is added deliberately', () => {
    expect([...CONTEXTUAL.keys()]).toEqual(['GlobalSettingsView.vue'])
  })
})
