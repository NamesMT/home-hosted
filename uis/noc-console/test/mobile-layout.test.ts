import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * noc-console reflows on a phone — the 860 px breakpoint was already there. What was wrong was
 * inside it, and it survived because the layout only breaks at a real viewport.
 *
 * Measured in Chromium against a real panel with two real running entries, signed in:
 *
 *  - the nav row ran 611 px wide in a 390 px viewport. `.nav` has `overflow-x: auto`, so it
 *    could scroll — but nothing said so, and `reverse proxy` (458–523) and `keyboard`
 *    (527–607) sat entirely off screen;
 *  - the status line ran 866 px, of which the keyboard hint was 588: the live segments the
 *    phone actually needs were the part pushed under the right edge;
 *  - the servers table was 871 px wide in a 390 px window, so UPTIME / 24H UP / ACT were cut —
 *    including the start/stop/restart/edit buttons;
 *  - the rail's CPU/LOAD/MEM/SWAP/DISK cells and the panel URL ran past the edge.
 *
 * This is the same choice `uis/stock/test/mobile-layout.test.ts` made, for the same reason: a
 * mount has no layout engine, and the scan catches the next author. It reads the two files that
 * decide the phone layout — the shell's markup and the stylesheet — and states each rule as a
 * rule about layout rather than as "the component that broke".
 */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))

const shell = fs.readFileSync(path.join(root, 'src/App.vue'), 'utf8')
const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8')

/**
 * Every `@media` block with a condition, concatenated: the phone layout is written in more than
 * one block (the table rules sit next to the tables they describe, the shell rules next to the
 * shell), and a scan that read only the first one would silently miss half the layout.
 */
function mediaBody(condition: string): string {
  const bodies: string[] = []
  let from = 0
  for (;;) {
    const start = styles.indexOf(`@media ${condition}`, from)
    if (start === -1)
      break
    const open = styles.indexOf('{', start)
    let depth = 0
    let index = open
    for (; index < styles.length; index++) {
      if (styles[index] === '{')
        depth++
      else if (styles[index] === '}')
        depth--
      if (depth === 0 && index > open)
        break
    }
    bodies.push(styles.slice(open + 1, index))
    from = index
  }
  expect(bodies.length, `no @media ${condition} block`).toBeGreaterThan(0)
  return bodies.join('\n')
}

/**
 * Every declaration that applies to one selector in a block, concatenated.
 *
 * A selector can be written more than once (`.tblwrap` sets its scroll and, separately, its edge
 * shadows) and can be one of several in a selector list (`.tbl__keep, .tbl__actions`). Reading
 * only the first `selector { … }` would test half a rule and pass a broken layout.
 */
function ruleIn(block: string, selector: string): string {
  const declarations: string[] = []
  for (const rule of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (rule[1] ?? '')
      // Drop a trailing comment: `\n  /* why */\n  .tbl__keep` is one selector, not a comment.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map(part => part.trim())
    if (selectors.includes(selector))
      declarations.push(rule[2] ?? '')
  }
  return declarations.join('\n')
}

describe('noc-console is usable at a phone width', () => {
  it('finds the shell and its responsive block, so a rename cannot pass for free', () => {
    expect(shell).toContain('<nav class="nav"')
    expect(shell).toContain('footer class="status"')
    expect(mediaBody('(width <= 860px)').length).toBeGreaterThan(200)
  })

  /**
   * A row that scrolls horizontally with no signal reads as a clipped row. The nav is the worst
   * case, because the items past the edge *are* the only way to reach those pages. So at this
   * width it wraps instead: a wrapped label is visible, a scrolled-past one is not.
   */
  it('wraps the nav on a phone instead of hiding items behind a horizontal scroll', () => {
    const mobile = mediaBody('(width <= 860px)')
    const nav = ruleIn(mobile, '.nav')
    expect(nav, '.nav in the phone block').toContain('flex-wrap: wrap')
    expect(nav, '.nav must not keep a hidden horizontal scroll').not.toContain('overflow-x: auto')
  })

  /**
   * The secondary pages go behind a `more` toggle below 640 px. The toggle is what makes the nav
   * fit without shortening the labels: `workspace settings` alone is 127 px of a 390 px row.
   * The tier is split from the 860 px layout breakpoint because a 700 px window fits the row.
   */
  it('moves the secondary pages behind a `more` toggle below 640px', () => {
    expect(shell).toContain('nav__more')
    expect(shell).toContain('nav__item--secondary')
    expect(shell).toMatch(/v-if|nav--more-open|@click="navMore/)
    const tier = mediaBody('(width <= 640px)')
    expect(ruleIn(tier, '.nav__item--secondary')).toContain('display: none')
    expect(tier).toContain('.nav--more-open .nav__item--secondary')
    expect(shell).toContain(':aria-expanded="navMore"')
  })

  /**
   * Between 641 and 860 px the pages are ordinary rows of a wrapping nav — the toggle is hidden
   * there, so a `display: none` on them in the *layout* block would leave those three pages
   * reachable from nowhere. Measured before this was split out: global settings, workspace
   * settings and reverse proxy had no entry at 700 px.
   */
  it('does not hide a page in a range where the toggle that holds it is also hidden', () => {
    const layout = mediaBody('(width <= 860px)')
    const secondary = ruleIn(layout, '.nav__item--secondary')
    expect(secondary).not.toContain('display: none')
  })

  /**
   * `button.nav__item` sets `width: 100%` for the desktop column, and that rule is more
   * specific than a bare `.nav__item`. In the wrapping row it made the keyboard button alone
   * take a whole line — measured at 844 px as three nav rows and a 149 px header.
   */
  it('lets a nav button be a chip in the wrapping row, where a column width would take a line', () => {
    const layout = mediaBody('(width <= 860px)')
    /*
     * The selector has to be *written*, not merely mentioned: an earlier version of this test
     * matched `button.nav__item` inside the rule's own explanatory comment, so deleting the
     * selector still passed. `ruleIn` matches only a rule's selector list.
     */
    expect(ruleIn(layout, 'button.nav__item')).toContain('width: auto')
    expect(ruleIn(layout, '.nav__item')).toContain('width: auto')
  })

  /**
   * The stacked layout puts the same four actions in the detail pane one tap below the selected
   * row, so the row's copy is a 205 px pinned column on a 390 px phone — half the screen — and
   * it squeezed `state` to 43 px of visible table. The split view keeps them.
   */
  it('drops the duplicated row actions only in the stacked layout', () => {
    expect(ruleIn(styles, '.split--stacked .tbl__actions')).toContain('display: none')
    // The wide layout's rule must not carry it: the split view renders the buttons.
    expect(ruleIn(styles, '.tbl__actions')).not.toContain('display: none')
  })

  /**
   * The status line's shortcut hint is 588 px of a 390 px bar, and a touch device has no `j` or
   * `s`. Gating it on `hover: hover` (not on width) keeps it for a narrow desktop window, which
   * does have a keyboard.
   */
  it('hides the keyboard-shortcut hint unless the pointer can hover', () => {
    const hint = ruleIn(styles, '.status__hint')
    expect(hint).toContain('display: none')
    const hover = mediaBody('(hover: hover)')
    expect(ruleIn(hover, '.status__hint')).toContain('display: inline')
  })

  /**
   * A table wider than the viewport has to scroll, but the row's identity and its actions are
   * the two things that must not scroll away: without the pinned id you cannot tell which row
   * you are reading, and without the pinned actions the only way to start a server is to scroll
   * to the far right — which is what was cut off.
   */
  it('pins the identity and action columns of a wide table on a phone', () => {
    const mobile = mediaBody('(width <= 860px)')
    expect(ruleIn(mobile, '.tbl__keep')).toContain('position: sticky')
    expect(ruleIn(mobile, '.tbl__actions')).toContain('position: sticky')
    // The pinned cell needs its own opaque background, or content scrolls visibly beneath it.
    expect(ruleIn(mobile, '.tbl__keep')).toContain('background')
  })

  /**
   * The scroll affordance: a shadow at whichever edge still has content behind it, with no
   * script. `background-attachment: local` is what makes it appear and disappear as the table
   * scrolls, so a table that fits shows no shadow at all.
   */
  it('gives a scrollable table a visible edge hint', () => {
    const wrap = ruleIn(styles, '.tblwrap')
    expect(wrap).toContain('background-attachment: local')
    expect(wrap).toContain('scroll')
  })

  /**
   * The table cells themselves carry the classes the sticky rules act on, so a new table cannot
   * ship without one: this is the "fix the class, not the instance" half of the guard.
   */
  it('marks a table with both a pinned identity cell and a pinned action cell', () => {
    const missing: string[] = []
    const views = ['src/components/ServerList.vue', 'src/views/GlobalOverviewView.vue']
    for (const view of views) {
      const source = fs.readFileSync(path.join(root, view), 'utf8')
      if (!source.includes('tbl__keep'))
        missing.push(`${view}: no .tbl__keep cell`)
    }
    expect(missing).toEqual([])
  })

  /**
   * A wrapped header is taller than its 38 px floor, and as a shrinkable flex child of `.view` it
   * painted over the table beneath it — measured as the filter box and the first row overlapping
   * the `start all` row. Chrome is not content: it does not shrink.
   */
  it('keeps a wrapped header from being squeezed over the content below it', () => {
    expect(ruleIn(styles, '.view__head')).toContain('flex: none')
    expect(ruleIn(styles, '.pane__head')).toContain('flex: none')
  })

  /** A rail item is as wide as its text unless it is told it may be narrower; the panel URL is not. */
  it('lets a rail link ellipsize instead of widening the rail past the viewport', () => {
    const mobile = mediaBody('(width <= 860px)')
    const link = ruleIn(mobile, '.rail__link')
    expect(link).toContain('min-width: 0')
    expect(link).toContain('text-overflow: ellipsis')
  })
})
