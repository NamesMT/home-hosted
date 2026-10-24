import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every modal surface in this console is owned by the modal layer.
 *
 * The registry (see `test/modal-layer.test.ts` for the behaviour and the Chromium measurements)
 * is only as good as its use sites: an overlay that renders `class="overlay"` with
 * `role="dialog"` and is not registered is back to drawing an `esc` keycap that does nothing, and
 * back to letting `x` stop a server behind it. Neither failure is visible to a mount — both are
 * about the shell's key handling rather than about the component's own markup.
 *
 * Two ways a surface is owned, and the scan accepts exactly these:
 *
 *  - it calls `useModalLayer` itself (the dialogs whose open state lives in the component), or
 *  - its open state is a ref the shell registers, which the shell does in one block in `App.vue`.
 *    The scan reads that block rather than trusting a comment, so deleting a line there fails here.
 *
 * The scan is a rule, not a denylist: it derives the set of files that *are* a modal from their own
 * markup, so an overlay added tomorrow is covered by having been written the same way.
 */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))

/** The one non-modal overlay: it sits beside the page and blocks no shortcut. */
const NON_MODAL = new Map([
  ['LogDrawer.vue', 'a drawer beside the page, not a modal: the shell deliberately leaves `j`/`s` live'],
])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory())
      out.push(...walk(full))
    else if (entry.name.endsWith('.vue'))
      out.push(full)
  }
  return out
}

/** A file is a modal when it renders an overlay panel as a dialog. */
function isModal(text: string): boolean {
  return /class="overlay"/.test(text) && /role="dialog"/.test(text)
}

const files = walk(path.join(root, 'src'))
const texts = files.map(file => fs.readFileSync(file, 'utf8'))
const shell = fs.readFileSync(path.join(root, 'src/App.vue'), 'utf8')

/** The state refs the shell hands to the registry: one `useModalLayer(() => <flag>.value, …)` per line. */
const shellOwned = new Set(
  [...shell.matchAll(/useModalLayer\(\(\)\s*=>\s*([A-Za-z_$][\w$]*)\.value/g)].map(match => match[1]!),
)

/**
 * The refs a view or component opens a `v-if`d overlay with. The whole open tag is read, not the
 * text after `class="overlay"`: `v-if` is written *before* the class, so a scan anchored on the
 * class silently reported every shell-owned sheet as unregistered.
 */
function gatedFlags(text: string): string[] {
  // `v-if="open"` is the dialog's own prop, not a ref: the mount flag is what owns it, and that is
  // read from the mount site (`mountFlags`) rather than counted here as an unregistered flag.
  const localProps = new Set(['open'])
  return [...text.matchAll(/<div\s[^>]*class="overlay"[^>]*>/g)]
    .flatMap(([tag]) => [...tag.matchAll(/v-if="([A-Za-z_$][\w$]*)/g)].map(match => match[1]!))
    .filter(flag => !localProps.has(flag))
}

/**
 * The flags a component is mounted with, e.g. `<AddServerDialog :open="addOpen">` → `addOpen`.
 *
 * A dialog that takes an `open` prop cannot register a state it does not hold, so it is only owned
 * when the thing that mounts it hands it a flag the shell registered. Reading the prop's *presence*
 * was not enough: `BackupDialog` also takes one, but its mount flag is a view-local ref, and that
 * exemption made the scan pass with the registration deleted.
 */
function mountFlags(name: string, all: string[]): string[] {
  const out: string[] = []
  for (const text of all) {
    for (const [tag] of text.matchAll(new RegExp(`<${name.replace(/\.vue$/, '')}\\b[^>]*>`, 'g'))) {
      for (const [, flag] of tag.matchAll(/:open="([A-Za-z_$][\w$]*)/g))
        out.push(flag!)
    }
  }
  return out
}

describe('every modal overlay owns the keyboard', () => {
  it('finds the modal surfaces at all, so the scan cannot pass by finding nothing', () => {
    const modals = files.filter(file => isModal(fs.readFileSync(file, 'utf8')))
    // Twelve today; the floor catches a scan that stopped reading (a rename, a bad path) rather
    // than pinning an exact count that every new dialog would have to bump for no reason.
    expect(modals.length).toBeGreaterThanOrEqual(10)
  })

  it('registers one layer and no second keydown listener', () => {
    const failures: string[] = []
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      const name = path.basename(file)
      if (!isModal(text) || NON_MODAL.has(name))
        continue

      const owns = text.includes('useModalLayer(')
      const flags = [...gatedFlags(text), ...mountFlags(name, texts)]
      const shellKnows = flags.length > 0 && flags.every(flag => shellOwned.has(flag))
      if (!owns && !shellKnows) {
        const named = flags.length === 0 ? 'no open flag the shell registers' : flags.join(', ')
        failures.push(`${name}: renders a role="dialog" overlay, registers no layer (${named})`)
      }
      /*
       * A second `keydown` listener is how the four broken dialogs were written, and it is what the
       * registry replaced: one listener in the shell decides, so two overlays cannot both act on
       * one Escape and the topmost is the one that closes.
       */
      if (/addEventListener\(\s*'keydown'/.test(text))
        failures.push(`${name}: adds its own keydown listener instead of the shared modal layer`)
    }
    expect(failures).toEqual([])
  })

  it('never advertises an esc keycap on a surface nothing closes', () => {
    const failures: string[] = []
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      const name = path.basename(file)
      if (!isModal(text) || NON_MODAL.has(name) || !/kbd class="kbd">esc</.test(text))
        continue
      const flags = [...gatedFlags(text), ...mountFlags(name, texts)]
      const owned = text.includes('useModalLayer(') || (flags.length > 0 && flags.every(flag => shellOwned.has(flag)))
      if (!owned)
        failures.push(`${name}: shows an esc keycap but nothing closes it on Escape`)
    }
    expect(failures).toEqual([])
  })
})
