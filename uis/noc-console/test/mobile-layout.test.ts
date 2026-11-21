import type { CssRule } from '../../../test/helpers/strip-comments'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cssRules, stripComments } from '../../../test/helpers/strip-comments'

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
/** Every rule, for the assertions that are about the sheet rather than a breakpoint. */
const allRules = cssRules(styles)

/**
 * The rules inside one `@media` tier, as `selector { body }` text.
 *
 * The phone layout is written in more than one block (the table rules sit next to the tables they
 * describe, the shell rules next to the shell), and a scan that read only the first one would
 * silently miss half the layout — so every block carrying the condition contributes.
 *
 * The parse is `cssRules` (`test/helpers/strip-comments.ts`), because this stylesheet breaks a
 * regex: `.probe::after { content: '/*' }` opened a "comment" that ran to the next `/*` and deleted
 * the rules between them, so a `flex-wrap: wrap` that had been removed stayed green.
 */
function rulesIn(condition: string): CssRule[] {
  const found = cssRules(styles).filter(rule => rule.media.includes(condition))
  expect(found.length, `no @media ${condition} rule`).toBeGreaterThan(0)
  return found
}

/**
 * Every declaration that applies to one selector in a tier, concatenated.
 *
 * A selector can be written more than once (`.tblwrap` sets its scroll and, separately, its edge
 * shadows) and can be one of several in a selector list (`.tbl__keep, .tbl__actions`). Reading
 * only the first `selector { … }` would test half a rule and pass a broken layout.
 */
function ruleIn(rules: CssRule[], selector: string): string {
  return rules
    .filter(rule => rule.selectors.includes(selector))
    .map(rule => rule.body)
    .join('\n')
}

describe('noc-console is usable at a phone width', () => {
  it('finds the shell and its responsive block, so a rename cannot pass for free', () => {
    expect(shell).toContain('<nav class="nav"')
    expect(shell).toContain('footer class="status"')
    expect(rulesIn('(width <= 860px)').length).toBeGreaterThan(20)
  })

  /**
   * A row that scrolls horizontally with no signal reads as a clipped row. The nav is the worst
   * case, because the items past the edge *are* the only way to reach those pages. So at this
   * width it wraps instead: a wrapped label is visible, a scrolled-past one is not.
   */
  it('wraps the nav on a phone instead of hiding items behind a horizontal scroll', () => {
    const mobile = rulesIn('(width <= 860px)')
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
    const tier = rulesIn('(width <= 640px)')
    expect(ruleIn(tier, '.nav__item--secondary')).toContain('display: none')
    // The toggle re-shows them, and that re-show must be written as a selector of its own.
    expect(tier.flatMap(rule => rule.selectors)).toContain('.nav--more-open .nav__item--secondary')
    expect(shell).toContain(':aria-expanded="navMore"')
  })

  /**
   * Between 641 and 860 px the pages are ordinary rows of a wrapping nav — the toggle is hidden
   * there, so a `display: none` on them in the *layout* block would leave those three pages
   * reachable from nowhere. Measured before this was split out: global settings, workspace
   * settings and reverse proxy had no entry at 700 px.
   */
  it('does not hide a page in a range where the toggle that holds it is also hidden', () => {
    const layout = rulesIn('(width <= 860px)')
    const secondary = ruleIn(layout, '.nav__item--secondary')
    expect(secondary).not.toContain('display: none')
  })

  /**
   * `button.nav__item` sets `width: 100%` for the desktop column, and that rule is more
   * specific than a bare `.nav__item`. In the wrapping row it made the keyboard button alone
   * take a whole line — measured at 844 px as three nav rows and a 149 px header.
   */
  it('lets a nav button be a chip in the wrapping row, where a column width would take a line', () => {
    const layout = rulesIn('(width <= 860px)')
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
    expect(ruleIn(allRules, '.split--stacked .tbl__actions')).toContain('display: none')
    // The wide layout's rule must not carry it: the split view renders the buttons.
    expect(ruleIn(allRules, '.tbl__actions')).not.toContain('display: none')
  })

  /**
   * The status line's shortcut hint is 588 px of a 390 px bar, and a touch device has no `j` or
   * `s`. Gating it on `hover: hover` (not on width) keeps it for a narrow desktop window, which
   * does have a keyboard.
   */
  it('hides the keyboard-shortcut hint unless the pointer can hover', () => {
    const hint = ruleIn(allRules, '.status__hint')
    expect(hint).toContain('display: none')
    const hover = rulesIn('(hover: hover)')
    expect(ruleIn(hover, '.status__hint')).toContain('display: inline')
  })

  /**
   * A table wider than the viewport has to scroll, but the row's identity and its actions are
   * the two things that must not scroll away: without the pinned id you cannot tell which row
   * you are reading, and without the pinned actions the only way to start a server is to scroll
   * to the far right — which is what was cut off.
   */
  it('pins the identity and action columns of a wide table on a phone', () => {
    const mobile = rulesIn('(width <= 860px)')
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
    const wrap = ruleIn(allRules, '.tblwrap')
    expect(wrap).toContain('background-attachment: local')
    expect(wrap).toContain('scroll')
    // The two `local` layers are covers, so their colour has to be the ground behind the table.
    // Hardcoded to `--ink` they are right only while every table sits on ink; stock shipped the
    // same shape and a table on the page ground got a band that covered its last column.
    expect(wrap, 'the cover is a declared surface, not an assumed one').toContain('--scroll-cover')
    expect(wrap).toContain('var(--scroll-cover)')
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
   * **Every** `<table>` sits inside `.tblwrap`, discovered rather than listed.
   *
   * `AccountsSection.vue` did not, and it was the only one: measured in Chromium on
   * `/global/settings`, the accounts table is **605 px wide inside a 296 px box at 320 px** (and
   * 366 px at 390 px), with `overflow-x: visible` — so the page itself scrolled sideways and the
   * `disable`/`revoke` buttons sat off-screen. `.tblwrap` is what gives the scroller its edge hint,
   * so an unwrapped table is not only sideways, it is silent about being scrollable.
   *
   * The two cases above name their files by hand, which is why this one went unseen: a table added
   * later was covered by nothing. This walks every `.vue` under `src/` instead.
   */
  it('wraps every table in the scroll container that gives it an edge hint', () => {
    const unwrapped: string[] = []
    for (const entry of fs.readdirSync(path.join(root, 'src'), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.vue'))
        continue
      const file = path.join(entry.parentPath, entry.name)
      const source = fs.readFileSync(file, 'utf8')
      /**
       * The template region with comments stripped.
       *
       * Stripping is load-bearing, and the first version of this guard was fooled by exactly the thing
       * it was written next to: the `<!-- -->` explaining *why* the accounts table needs `.tblwrap`
       * contains the word `tblwrap`, and it sat after the last `</div>`, so `lastIndexOf('tblwrap')`
       * found the comment and called an unwrapped table wrapped. Verified by un-wrapping the table and
       * watching the guard stay green — which is how a guard that reads prose instead of markup fails.
       */
      const template = source
        .slice(source.indexOf('<template>'), source.lastIndexOf('</template>'))
        .replaceAll(/<!--[\s\S]*?-->/g, '')
      // A table counts as wrapped when a `.tblwrap` container opens before it and closes after.
      for (const match of template.matchAll(/<table\b/g)) {
        const before = template.slice(0, match.index)
        const opened = before.lastIndexOf('tblwrap')
        const closed = before.lastIndexOf('</div>', match.index)
        if (opened === -1 || opened < closed)
          unwrapped.push(path.relative(path.join(root, 'src'), file))
      }
    }
    expect(unwrapped, 'a table outside .tblwrap scrolls the page sideways without saying so').toEqual([])
  })

  /**
   * A wrapped header is taller than its 38 px floor, and as a shrinkable flex child of `.view` it
   * painted over the table beneath it — measured as the filter box and the first row overlapping
   * the `start all` row. Chrome is not content: it does not shrink.
   */
  it('keeps a wrapped header from being squeezed over the content below it', () => {
    expect(ruleIn(allRules, '.view__head')).toContain('flex: none')
    expect(ruleIn(allRules, '.pane__head')).toContain('flex: none')
  })

  /**
   * The same rule one level down: a `.pane` that is a **direct child of the scrolling `.view`**.
   * `.view` is `flex-direction: column` with `overflow: auto`, so each child is a flex item, and
   * the default `flex-shrink: 1` lets a pane be squeezed below the height of its own content.
   * `.pane` carries no `overflow`, so the remainder is not scrollable — it is simply painted over
   * by the next sibling.
   *
   * Measured in Chromium on `/global/overview` at 320×568, with the fix stashed: host vitals was
   * **445 px of content in a 205 px box**, and 4 of its labels (the `swap` tile, `cpu temp`, its
   * `—` value and one more) sat behind the workspace pane's header. At 320×700 the filesystems
   * table went under instead — 9 of its labels, `path` / `total` / `free` / `used` / `usage` and
   * every value among them; 11 at 360×640; 1 at 390×700. Scrolling `.view` to `scrollHeight`
   * revealed none of them, because the box itself was what shrank. The same page at 1280×420
   * (a short desktop window) shrank by 28 px with nothing yet hidden.
   *
   * The servers split already writes this for its own halves
   * (`.split__half--detail > .pane` is `flex: 0 0 auto`); the page column was the case nobody
   * wrote down. Asserted here beside the header rule, because it is the same mistake.
   */
  it('does not let a page-level pane shrink below its own content', () => {
    const pane = ruleIn(allRules, '.view > .pane')
    expect(pane, '.view > .pane must not shrink: the overflow would paint over it').toContain('flex: none')
    // Not a blanket `flex: none` on every pane: inside `.split__half--detail` the pane is sized
    // by its own half, and a page form's panes scroll with the page.
    expect(ruleIn(allRules, '.pane'), 'the base .pane stays shrinkable for its scrolling hosts').not.toContain('flex: none')
  })

  /** A rail item is as wide as its text unless it is told it may be narrower; the panel URL is not. */
  it('lets a rail link ellipsize instead of widening the rail past the viewport', () => {
    const mobile = rulesIn('(width <= 860px)')
    const link = ruleIn(mobile, '.rail__link')
    expect(link).toContain('min-width: 0')
    expect(link).toContain('text-overflow: ellipsis')
  })

  /**
   * The jobs table scrolls inside its own box, and its identity column is capped on a phone.
   *
   * Both are one defect. The identity cell is a three-line block — id, label and the command with
   * its arguments — and nothing bounded any of them, so the cell sized itself to the command. As a
   * bare child of `.view` that made the *page* 592 px wide at a 320 px viewport, which carried the
   * sticky header with it: dragging to the end put the page title and the `new job` button at
   * **x = -264**, entirely off screen. `.tblwrap` gives the table its own scroller and its edge
   * shadows, and `.view` no longer overflows (measured `scrollWidth - clientWidth`: 272 → 0).
   *
   * Pinning alone was not enough. The pinned identity cell measured **235 px of a 320 px
   * viewport** and the pinned action cell another 82, leaving a **3 px** window between them:
   * SCHEDULE, NEXT and LAST were each readable 3 px at a time however far you dragged, so the one
   * number the page exists to show — when it next runs — was gone. With the 45vw cap the window is
   * 95 px at 320 (schedule 80 and next 72 both fully visible), 133 px at 390 and 164 px at 430.
   * Capped at the identity *cell*, not the table, and scoped by `.tbl--jobs`: the servers table's
   * identity is one short line, and 45vw there clipped `Python server` to `Python` for no gain.
   */
  it('scrolls the jobs table itself and caps its identity column on a phone', () => {
    const jobs = fs.readFileSync(path.join(root, 'src/views/JobsView.vue'), 'utf8')
    // The table opts into its own scroller rather than stretching the page.
    expect(jobs, 'the jobs table needs its own scroll box').toContain('class="tblwrap"')
    expect(jobs, 'the cap is scoped by a modifier the table carries').toContain('class="tbl tbl--jobs"')

    const mobile = rulesIn('(width <= 860px)')
    const keep = ruleIn(mobile, '.tbl--jobs .tbl__keep')
    expect(keep, 'an unbounded identity column eats the pinned window').toContain('max-width: 45vw')
    expect(keep).toContain('overflow: hidden')
    // The lines have to ellipsize: a wrap would make every row a line taller instead.
    for (const selector of ['.tbl--jobs .tbl__keep .label', '.tbl--jobs .tbl__keep p']) {
      expect(ruleIn(mobile, selector), `${selector} must ellipsize`).toContain('text-overflow: ellipsis')
    }
    // Deliberately not a blanket cap: the servers table keeps its full name.
    expect(ruleIn(allRules, '.tbl__keep'), 'the base .tbl__keep must stay unbounded').not.toContain('max-width')
  })

  /**
   * The pinning rule above is written in the stylesheet, but a table only gets it if its cells
   * carry the classes — and two of the console's four tables did not.
   *
   * Measured in Chromium 157 at a 320 px viewport: the jobs table ran 593 px wide, and its
   * action column (512–593) plus the `run now` button (520–585) sat entirely past the right edge,
   * so every job row's only actions were two horizontal scrolls away. The accounts table's scopes
   * column started at 90 px and ran to 321 — one pixel past the viewport — pushing `workspaces`
   * and the `disable`/`revoke` buttons off. Both are fixed by naming the cells the stylesheet
   * already knows: `.tbl__keep` on the identity, `.tbl__actions` on the actions.
   *
   * Every `.tbl` is required to carry both, so a fifth table cannot ship with the same gap.
   */
  it('marks every table with the pinned identity and action cells it needs to be readable', () => {
    const missing: string[] = []
    for (const entry of fs.readdirSync(path.join(root, 'src'), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.vue'))
        continue
      const file = path.join(entry.parentPath, entry.name)
      const source = fs.readFileSync(file, 'utf8')
      if (!source.includes('class="tbl"'))
        continue
      const relative = path.relative(root, file)
      // A read-only table (`HostVitals`, `DdnsPanel`, the overview's server list) still needs its
      // identity pinned: whichever column says *which row* is the one that must not scroll away.
      if (!source.includes('tbl__keep'))
        missing.push(`${relative}: no .tbl__keep on the identity cell`)
      // A table that carries row actions needs the action cell pinned too. The `sr-only actions`
      // header is how every one of them declares it, and it is what the two broken tables had.
      if (source.includes('sr-only">actions') && !source.includes('tbl__actions'))
        missing.push(`${relative}: no .tbl__actions on the action cell`)
    }
    expect(missing).toEqual([])
    // The two tables this change fixed, named so the scan cannot pass by finding nothing.
    for (const view of ['src/views/JobsView.vue', 'src/components/AccountsSection.vue']) {
      const source = fs.readFileSync(path.join(root, view), 'utf8')
      expect(source, `${view} pins its identity cell`).toContain('class="tbl__keep"')
      expect(source, `${view} pins its action cell`).toContain('class="tbl__actions"')
    }
  })
})

/**
 * A grid floor wider than its container overflows instead of collapsing.
 *
 * `.grid` and `.grid--wide` are `repeat(auto-fit, minmax(<floor>, 1fr))`. `minmax` cannot size a
 * track below its floor, so in a container narrower than 280 px the track stays 280 and the fields
 * inside run past the box rather than reflowing to one column.
 *
 * Measured in Chromium in the add-server dialog with ADVANCED open at 320 px: `.grid--wide` was
 * **238 px** wide with a single **280 px** track, and its five health-HTTP fields (HTTP path,
 * method, exact status, healthy-below, body-contains) reached x=**321** inside a dialog ending at
 * x=**304** — 17 px beyond the panel, with the dialog body carrying an unreported 18 px horizontal
 * overflow. At 360 px it was 278 px wide and still 2 px out; at 390 px it fit. After the change the
 * body overflow is 0 at 320/360/390 and the grid still shows two columns at 900/1280.
 *
 * The scan reads the declaration rather than the rendered box, because a mount has no layout
 * engine; it is stated as a rule about the floor so the next `minmax(...)` gets caught too.
 */
describe('a grid floor never exceeds the container', () => {
  /** Every `minmax(<floor>, …)` in the sheet, with the selector it belongs to. */
  const floors = allRules.flatMap((rule) => {
    const out: Array<{ selector: string, floor: string }> = []
    // Split rather than one loose pattern: the lint rules refuse a regex whose quantifiers can
    // exchange characters (`\s*` beside `[^,]+`), because that is super-linear backtracking.
    for (const part of rule.body.split('minmax(').slice(1)) {
      const floor = part.slice(0, part.indexOf(',')).trim()
      if (floor.length > 0)
        out.push({ selector: rule.selectors.join(', '), floor })
    }
    return out
  })

  it('the form grids use a floor that yields to the container', () => {
    // Anti-vacuity: the sheet really does declare these.
    expect(floors.length, 'the scan must find the grid floors').toBeGreaterThan(0)

    /**
     * Scoped to the two form grids rather than every `minmax` in the sheet. `.metrics`
     * (`118px`), `.logpage` (`180px`) and `.vitals` (`230px`) carry fixed floors too, but their
     * containers are always wider than the floor at any viewport the UI supports — measured at 320
     * and 240 px on four routes, none of them overflows — so widening the guard to them would
     * change a layout that is not broken in the name of consistency.
     *
     * These two are different: they sit inside dialogs, whose width is the viewport minus padding,
     * so the container shrinks below the floor exactly where the add-server form is used on a
     * phone. A fixed floor (`280px`, `190px`) overflows there; `min(<floor>, 100%)` collapses to the
     * container instead.
     */
    const fixed = floors
      .filter(entry => entry.selector.includes('.grid'))
      .filter(entry => /^\d+(?:\.\d+)?px$/.test(entry.floor))
      .map(entry => `${entry.selector} { minmax(${entry.floor}, …) }`)

    expect(fixed, 'a fixed px floor overflows a dialog narrower than it').toEqual([])
  })

  it('keeps the two form grids on the container-aware floor', () => {
    const grid = ruleIn(allRules, '.grid')
    const wide = ruleIn(allRules, '.grid--wide')
    expect(grid, '.grid must yield to its container').toContain('min(190px, 100%)')
    expect(wide, '.grid--wide must yield to its container').toContain('min(280px, 100%)')
  })
})

/**
 * Every route needs a `main` landmark and a heading, and noc-console had neither.
 *
 * Measured in Chromium on the installed build: `document.querySelectorAll('main').length` was
 * **0** and `h1` **0** on all eight routes — `/global/overview`, `/w/default/servers`, `/jobs`,
 * `/logs`, `/settings`, `/global/settings`, `/proxy` and a server's config page — while the
 * workspace settings page carried one stray `h4` (a group title) and the config page another. stock
 * has both on every page. A screen reader's "skip to the main content" and its heading list are
 * the two ways a keyboard-first console is actually used, and both were empty: the nav rail was the
 * only region on the page.
 *
 * The fix is one element (the `.main` box became a `<main>`, so the layout is identical) and the
 * page title became its `<h1>`. The guard reads the shell and every view, because a new view that
 * keeps `span` is exactly how this returns.
 */
describe('every page has a landmark and a heading', () => {
  it('renders a main landmark in the shell', () => {
    // Comments stripped first: the note explaining this fix names `<main>`, and a scan that counted
    // it would fail for the documentation that exists to prevent the bug.
    const markup = stripComments(shell, 'App.vue')
    expect(markup, 'the shell needs a <main>, not another <div>').toMatch(/<main[\s>]/)
    // One, and not nested inside a second one.
    expect((markup.match(/<main[\s>]/g) ?? []).length).toBe(1)
  })

  it('makes every view title the page h1', () => {
    const views = fs.readdirSync(path.join(root, 'src/views')).filter(name => name.endsWith('.vue')).sort()
    expect(views.length, 'the views are where the titles live').toBeGreaterThan(7)
    const offenders: string[] = []
    for (const name of views) {
      const source = fs.readFileSync(path.join(root, 'src/views', name), 'utf8')
      // The login page is its own shell (no nav, no view chrome) and has no `view__title`.
      if (!source.includes('view__title'))
        continue
      if (!/<h1[^>]*class="[^"]*view__title/.test(source))
        offenders.push(`${name}: view__title is not an <h1>`)
    }
    // The login page is its own shell and names itself with `overlay__title`.
    const login = fs.readFileSync(path.join(root, 'src/views/LoginView.vue'), 'utf8')
    if (!/<h1[^>]*class="[^"]*overlay__title/.test(login))
      offenders.push('LoginView.vue: the sign-in page has no <h1>')
    expect(offenders, 'the page title is the heading a screen reader announces').toEqual([])
    // And every view that owns a title was found, so a renamed class cannot pass for free.
    const titled = views.filter(name => fs.readFileSync(path.join(root, 'src/views', name), 'utf8').includes('view__title'))
    expect(titled.length, 'a view with a title was found').toBeGreaterThan(6)
  })
})
