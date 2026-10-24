import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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

/** Comments removed, so a docstring quoting the API is not read as a call. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('the clipboard has one writer', () => {
  it('finds the sources to check, so a broken glob cannot pass for free', () => {
    const files = fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && /\.(?:ts|vue)$/.test(entry.name))
    expect(files.length).toBeGreaterThan(20)
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
      const source = withoutComments(fs.readFileSync(file, 'utf8'))
      for (const match of source.matchAll(/navigator\s*\.\s*clipboard/g)) {
        const line = source.slice(0, match.index).split('\n').length
        offenders.push(`${relative}:${line}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
