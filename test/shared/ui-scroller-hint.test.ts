import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { templateRegion } from '../helpers/strip-comments'

/**
 * A horizontally scrolling box in **either** UI must say that it scrolls.
 *
 * A table wider than its box is cut off, and on a phone a scrollbar is invisible — so with no edge
 * shadow the last column is simply missing as far as the person reading it is concerned. Stock's Jobs
 * table put `Run now` 14 px past the right edge at rest and nothing said it was a scroll away;
 * noc-console shipped the same defect and fixed it with `.tblwrap`.
 *
 * **The two UIs mark it differently, which is why one guard could not cover both.**
 *
 *  - `stock` puts `scroll-hint-x` **on** the scroller, beside the `overflow-x-auto` utility that makes
 *    it one, so the class can be forgotten. `uis/stock/test/mobile-layout.test.ts` already scans its
 *    own `src/` for that; nothing here duplicates it.
 *  - `noc-console` wraps the table in a `.tblwrap` **ancestor**, and `overflow: auto` comes from that
 *    class in CSS rather than from a utility in the template. There is no per-scroller class to forget:
 *    a template either is inside a `.tblwrap` or has no horizontal scroller at all. That makes the
 *    defect impossible by construction here — but nothing asserted it, so the first table written the
 *    other way would silently reintroduce it.
 *
 * This pins the second half, and pins the *reason* the first half needs its own guard.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

function templates(ui: string): Array<{ file: string, body: string }> {
  const dir = path.join(root, 'uis', ui, 'src')
  const out: Array<{ file: string, body: string }> = []
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.vue')) {
      const file = path.join(entry.parentPath, entry.name)
      out.push({ file: path.relative(root, file).replaceAll('\\', '/'), body: templateRegion(fs.readFileSync(file, 'utf8')) })
    }
  }
  return out.sort((left, right) => left.file.localeCompare(right.file))
}

describe('a horizontal scroller announces itself', () => {
  /**
   * `noc-console` gets its scroller from `.tblwrap`, never from a utility class.
   *
   * So the invariant is: no template in this UI uses `overflow-x-auto`/`overflow-x-scroll` on its own,
   * because that would create a scroller with no edge hint — the stock defect, in the UI that has no
   * per-table guard. A table that needs to scroll is wrapped instead.
   */
  it('never hand-rolls a scroller in noc-console, where only .tblwrap carries the hint', () => {
    const offenders: string[] = []
    let wrappers = 0
    for (const { file, body } of templates('noc-console')) {
      for (const match of body.matchAll(/class="([^"]*\boverflow-x-(?:auto|scroll)\b[^"]*)"/g))
        offenders.push(`${file}: "${match[1] ?? ''}"`)
      wrappers += [...body.matchAll(/class="[^"]*\btblwrap\b[^"]*"/g)].length
    }
    expect(offenders, 'a bare `overflow-x-auto` here builds a scroller with no edge hint — wrap it in .tblwrap').toEqual([])
    // Anti-vacuity: the wrapper must still be the thing in use, or the rule above is describing nothing.
    expect(wrappers, 'no .tblwrap anywhere — the tables have moved to another mechanism').toBeGreaterThan(0)
  })

  it('keeps .tblwrap the scroller, with the edge shadow layered on it', () => {
    const styles = fs.readFileSync(path.join(root, 'uis', 'noc-console', 'src', 'styles.css'), 'utf8')
    /**
     * `.tblwrap` is declared **twice**, deliberately, and both halves matter.
     *
     * The first (`overflow: auto; min-height: 0`) is what makes it a scroller; the second, far below,
     * carries the edge shadow. Asserting only the first — which is what an anchored single match does —
     * finds a rule with no shadow and reports the shadow missing. So both rules are collected and each
     * property is required somewhere among them.
     */
    const rules = [...styles.matchAll(/^\.tblwrap\s*\{([^}]*)\}/gm)].map(match => match[1] ?? '')
    expect(rules.length, '.tblwrap is no longer declared — the tables have moved to another mechanism').toBeGreaterThan(0)

    const all = rules.join('\n')
    expect(all, '.tblwrap stopped being a scroller').toMatch(/overflow:\s*auto/)
    /**
     * The shadow itself. Stock uses the same four-layer technique; this UI paints its own, so the check
     * is the mechanism — `background-attachment: local` is what makes the shadow appear and disappear
     * with the scroll position, with no script — not a copy of stock's declaration.
     */
    expect(all, 'the scroller lost its edge shadow').toMatch(/background:\s*linear-gradient|background-image:/)
    expect(all, 'the shadow must follow the scroll position').toContain('background-attachment: local')
    expect(all, 'the cover colour must be a declared ground, not a hardcoded one').toContain('--scroll-cover')
  })

  /**
   * Stock is covered by `uis/stock/test/mobile-layout.test.ts`, which scans `uis/stock/src`. Recorded
   * here as an assertion rather than a comment so the split stays deliberate if that test moves.
   */
  it('leaves the stock scan to the stock test, which really does scan stock', () => {
    const test = fs.readFileSync(path.join(root, 'uis', 'stock', 'test', 'mobile-layout.test.ts'), 'utf8')
    expect(test, 'the stock scroller guard is gone — nothing checks scroll-hint-x now').toContain('scroll-hint-x')
    expect(test, 'the stock guard no longer scans for scrollers').toContain('overflow-x-auto')
  })
})
