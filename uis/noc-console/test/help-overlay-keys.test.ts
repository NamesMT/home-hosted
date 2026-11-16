import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The help overlay is the console's reference for its own keyboard, so a key it omits is a key a
 * person has no way to discover — and one it invents is worse, because the overlay is what they
 * trust over trying it.
 *
 * It listed every `g` destination except jobs: the nav rail shows `g j`, pressing `g` then `j`
 * navigates (`/w/default/servers` → `/w/default/jobs`, verified in Chromium), and the help
 * overlay — the one place listing all seven — had six. Nothing failed, because the overlay's rows
 * were a hand-written array with nothing comparing them to the keymap they describe.
 *
 * These read both sides from source: the shell's `GOTO` map and the overlay's own rows. That makes
 * the file the contract, which is what catches the *next* destination someone adds.
 */

const SHELL = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
const OVERLAY = readFileSync(new URL('../src/components/HelpOverlay.vue', import.meta.url), 'utf8')

/** The shell's `g <key>` destinations, as the router page each one names. */
function gotoKeysFromShell(): string[] {
  const block = /const GOTO: Record<[^>]+> = \{([\s\S]*?)\n\}/.exec(SHELL)
  expect(block, 'the shell no longer declares a GOTO map this test can read').not.toBeNull()
  return [...block![1]!.matchAll(/^\s*([a-z]):/gm)].map(match => match[1]!)
}

/** Every `g <key>` the overlay documents, read from its own `combo` literals. */
function documentedGoKeys(): string[] {
  return [...OVERLAY.matchAll(/combo: 'g ([a-z])'/g)].map(match => match[1]!)
}

describe('the keyboard help overlay', () => {
  it('lists every `g` destination the shell actually implements', () => {
    const shellKeys = gotoKeysFromShell()
    expect(shellKeys.length, 'the GOTO map parsed with no entries').toBeGreaterThan(4)

    const documented = documentedGoKeys()
    expect(documented.length, 'the overlay documented no `g` combinations').toBeGreaterThan(4)

    for (const key of shellKeys)
      expect(documented, `\`g ${key}\` works in the shell but the help overlay does not list it`).toContain(key)
    // …and the overlay must not document a combination that does nothing.
    for (const key of documented)
      expect(shellKeys, `the overlay documents \`g ${key}\`, which the shell does not implement`).toContain(key)
  })

  it('keeps the three groups the overlay is read through', () => {
    for (const title of ['navigate', 'act on the selected server', 'console'])
      expect(OVERLAY, `the "${title}" group is gone`).toContain(`title: '${title}'`)
  })
})
