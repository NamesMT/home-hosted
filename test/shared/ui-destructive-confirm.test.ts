import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * A destructive action confirms in a popover, never by arming the same button.
 *
 * `AGENTS.md` states it: *"a destructive action one click away confirms in a popover, never by
 * arming the same button for a second press — an impatient double click fires an armed button."*
 * Both UIs carry the popover component for it (`ConfirmButton`), and every settings section uses
 * it — except the one that deletes the uploaded UI.
 *
 * `InterfaceSection.vue` flipped its own label (`Revert to stock` → `Confirm revert`) and, on a
 * second click anywhere in a five-second window, called `DELETE /api/settings/ui`. That route
 * `rmSync`s `$HHOSTED_HOME/.hh/.ui` with no archive, so an impatient double click destroys a build
 * the person may have no copy of. The *same action* in `noc-console` already used `ConfirmButton`,
 * so this is one surface not following a rule its twin follows.
 *
 * The label-and-flag shape is the defect, not the spelling: so this reads the **shape** out of each
 * `.vue` — a button whose own label is chosen by a confirmation flag, and an action function that
 * raises that flag from the same click and then performs the action. A mount can only see the
 * component someone thought to mount; the next armed button would be written in a file no test
 * mounts, which is exactly how this one survived.
 */
function vueFiles(): string[] {
  const out: string[] = []
  for (const ui of ['stock', 'noc-console']) {
    const dir = path.join(root, 'uis', ui, 'src')
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.vue'))
        out.push(path.join(entry.parentPath, entry.name))
    }
  }
  return out.sort()
}

const rel = (file: string): string => path.relative(root, file).replaceAll('\\', '/')

/** A button whose visible label is picked by a confirmation flag: the armed-button shape. */
function armedLabels(source: string): string[] {
  const template = source.slice(source.indexOf('<template>'))
  const found: string[] = []
  for (const button of template.matchAll(/<(?:button|AppButton)\b([^>]*)>([\s\S]{0,400}?)<\/(?:button|AppButton)>/g)) {
    for (const slot of (button[2] ?? '').matchAll(/\{\{([\s\S]*?)\}\}/g)) {
      // `confirmingRevert ? … : …` — the same control, renamed, waiting for a second press.
      // `props.confirmLabel`/`confirmLabel` is the *separate* button inside the popover, which is
      // the pattern the rule asks for, so a bare identifier without a ternary is not a finding.
      if (/\bconfirming\w*\s*\?/.test(slot[1] ?? '') || /\bconfirm\w*\s*\?\s*t\(/.test(slot[1] ?? ''))
        found.push(`{{ ${(slot[1] ?? '').trim().replace(/\s+/g, ' ')} }}`)
    }
  }
  return found
}

/**
 * A function that raises an arming flag and then calls the destructive action it guards.
 *
 * Reading the function body is what separates "two honest answers in one popover" from "the same
 * button again": the popover's confirm handler does not raise anything, it just acts.
 */
function armingActions(source: string): string[] {
  const script = source.slice(0, source.indexOf('</script>'))
  // Any ref whose name carries the word: `confirmingRevert` and `confirmArmed` are the same idea,
  // and a fixed list of spellings is a guard the next author trips over by renaming a ref — measured
  // on the re-break, where `confirmArmed` walked past a `confirming\w*|armed\w*` list.
  const flags = [...script.matchAll(/const\s+(\w*(?:confirm|arm)\w*)\s*=\s*ref\(/gi)]
    .map(match => match[1]!)
  if (flags.length === 0)
    return []
  const found: string[] = []
  for (const fn of script.matchAll(/(?:async\s+)?function\s+(\w+)\s*\([^)]*\)[^{]*\{/g)) {
    const start = fn.index! + fn[0].length
    let depth = 1
    let index = start
    for (; index < script.length && depth > 0; index++) {
      if (script[index] === '{')
        depth++
      else if (script[index] === '}')
        depth--
    }
    const body = script.slice(start, index)
    const raised = flags.filter(flag => new RegExp(`\\b${flag}(?:\\.value)?\\s*=\\s*true`).test(body))
    if (raised.length === 0)
      continue
    // The action it guards is whatever the same function calls after the flag, so a handler that
    // only opens a confirmation is not a finding.
    const acted = /(?:await\s+)?(?:api|control|workspace|props)\??\.\w+\(/.test(body)
      || /\b(?:revertUi|uploadUi|remove|delete|destroy|clear|forget)\w*\s*\(/.test(body)
    if (acted)
      found.push(`${fn[1]} raises ${raised.join(', ')} and then acts`)
  }
  return found
}

describe('a destructive action confirms in a popover, not by arming its own button', () => {
  it('finds the components to check, so a broken glob cannot pass for free', () => {
    // Anti-vacuity: every assertion below is a "no offenders" list, which an empty file set would
    // satisfy. Both UIs are Vue apps with dozens of components.
    expect(vueFiles().length).toBeGreaterThan(60)
  })

  it('never renames a button into its own confirmation', () => {
    const offenders = vueFiles()
      .flatMap(file => armedLabels(fs.readFileSync(file, 'utf8')).map(found => `${rel(file)}: ${found}`))
    expect(offenders, 'an armed button puts the destructive action under the second click of a double click').toEqual([])
  })

  it('never raises an arming flag and performs the action in the same click', () => {
    const offenders = vueFiles()
      .flatMap(file => armingActions(fs.readFileSync(file, 'utf8')).map(found => `${rel(file)}: ${found}`))
    expect(offenders, 'the second press is a different target — the popover — or it is a double click away').toEqual([])
  })
})
