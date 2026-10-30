import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stripComments } from '../../../test/helpers/strip-comments'

/**
 * The class rule behind the copy-button fix: **a copy is only ever `copyText`**.
 *
 * `navigator.clipboard` exists only in a secure context, so on the plain-`http://` LAN origin
 * this panel documents (`docs/UI_CREATION.md` point 7) it is `undefined` and every direct
 * `navigator.clipboard.writeText` is a dead button. `CopyButton` was the one call site, and it
 * now goes through `src/lib/clipboard.ts`, which falls back to `execCommand` and reports a
 * failure the person can see.
 *
 * A mount test cannot see the next author's component — there is no render until someone
 * clicks — so this is a source scan, in the same shape as `untranslated-copy.test.ts`. The
 * helper is the single file allowed to name the API.
 */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const srcDir = path.join(root, 'src')

/**
 * Reaching the clipboard object, in every spelling that gets hold of it.
 *
 * The matcher was `navigator\s*\.\s*clipboard` — one spelling, not the API. `navigator['clipboard']`
 * and `const { clipboard } = navigator` are ordinary code, each reaches the same object, and each
 * walked past it: measured by planting all three in `CopyButton.vue` and watching this file stay
 * green. So the scan reads the *reach* — a property, a bracket, or a destructure out of `navigator`.
 *
 * The word alone is not the rule: `import { copyText } from '@/lib/clipboard'` is correct code and
 * contains it, which is why the import path is not a match here.
 */
const REACH = /navigator\s*(?:\.\s*clipboard|\[\s*['"`]clipboard['"`]\s*\])|\{[^}]*\bclipboard\b[^}]*\}\s*=\s*navigator/g

/** Every place a source reaches the clipboard object, comments excluded. */
function clipboardReaches(source: string): string[] {
  return [...stripComments(source).matchAll(REACH)].map(match => match[0])
}

describe('the clipboard has one writer', () => {
  it('finds the sources to check, so a broken glob cannot pass for free', () => {
    const files = fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && /\.(?:ts|vue)$/.test(entry.name))
    expect(files.length).toBeGreaterThan(20)
  })

  /**
   * Anti-vacuity for the matcher itself: the three spellings an author writes, and the two
   * non-offences that would make this guard fail on correct code.
   */
  it('reaches the API in every spelling, or the matcher is decoration', () => {
    expect(clipboardReaches('navigator.clipboard.writeText(t)'), 'the spelling it already caught').toHaveLength(1)
    expect(clipboardReaches('navigator[\'clipboard\'].writeText(t)'), 'bracket access').toHaveLength(1)
    expect(clipboardReaches('const { clipboard } = navigator\nclipboard?.writeText(t)'), 'a destructured alias').toHaveLength(1)
    expect(clipboardReaches('// navigator.clipboard is absent on http, so copyText guards it'), 'a comment is not a call').toHaveLength(0)
    expect(clipboardReaches('import { copyText } from \'@/lib/clipboard\''), 'the import path is not a reach').toHaveLength(0)
  })

  it('routes every clipboard write through the helper', () => {
    const offenders: string[] = []
    for (const entry of fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:ts|vue)$/.test(entry.name))
        continue
      const file = path.join(entry.parentPath, entry.name)
      const relative = path.relative(srcDir, file)
      // The helper itself is where the API belongs.
      if (relative === path.join('lib', 'clipboard.ts'))
        continue
      // Comments stripped by a stripper that knows a `//` in a URL is not a comment: the helper's
      // own docstring quotes `http://` addresses, and the old line-based strip truncated them.
      const source = stripComments(fs.readFileSync(file, 'utf8'), entry.name)
      for (const match of source.matchAll(REACH)) {
        const line = source.slice(0, match.index).split('\n').length
        offenders.push(`${relative}:${line}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
