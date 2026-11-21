import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { templateRegion } from '../../../test/helpers/strip-comments'
import { templateElements } from '../../../test/helpers/template-render'

/**
 * A phone is the page you check without walking to the desk, and it was unusable.
 *
 * Measured in Chromium at 320–414 px on a real panel with three ordinary entries: a
 * `docker compose -f /srv/media/docker-compose.yml up --remove-orphans` entry made every
 * server card 503 px wide, so the page scrolled sideways, the command was cut off and the
 * card's own `…` menu sat off the screen — the menu holding enable/disable, autostart, bind
 * and delete. The same shape reached the alternate UI's grid and the settings shell, and two
 * more places broke on their own: the page header's action row pushed its overflow menu past
 * the right edge at 360 px, and the command palette's row detail squeezed the row's *title* to
 * zero width while the chevron left the dialog.
 *
 * happy-dom has no layout engine, so a mount cannot measure any of this. What it can read is
 * the shape that produced it, and each rule below is a rule about layout rather than about the
 * one component that broke:
 *
 *  - An implicit single-column grid is sized by its items' **min-content**, and a cell holding
 *    an unbreakable `font-mono` command is as wide as that command. Naming the base column
 *    count (`grid-cols-1`) makes the track `minmax(0,1fr)` and the cell can ellipsize.
 *  - A `truncate` sibling only ellipsizes if the row lets it: a `shrink-0` sibling holding an
 *    interpolation keeps its full width, so the row's min-content grows past the container and
 *    the row overflows instead of the text clipping.
 *  - `shrink-0` on a `flex-wrap` row says "never narrower than my widest arrangement", which
 *    is the opposite of what wrapping is for.
 *
 * This is the same choice `untranslated-copy.test.ts` made and for the same reason: the scan
 * catches the next author, and it runs in the gate CI already has.
 */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const srcDir = path.join(root, 'src')

function templateFiles(): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.vue'))
      files.push(path.join(entry.parentPath, entry.name))
  }
  return files.sort()
}

/**
 * The `<template>` region, comments stripped so an explanation is never read as markup.
 *
 * Only comments and attribute values are needed, so a whole-file scan would also read the `class`
 * strings a script builds; those are real classes too, but they are composed through `cn()` and
 * this test deliberately checks what the markup declares. The shared reader (`templateRegion`)
 * blanks comments without reading a `<!--` inside a quoted attribute as an opener.
 */
function templateOf(source: string): string {
  return templateRegion(source)
}

const has = (classes: string[], name: string): boolean => classes.includes(name)

/** `sm:grid-cols-3` and friends: a column count that only applies above a breakpoint. */
const responsiveColumns = (classes: string[]): string[] => classes.filter(name => !name.startsWith('-') && /^(?:sm|md|lg|xl|2xl):grid-cols-/.test(name))

/** Any class that names a base column count, so the single-column track is `minmax(0,1fr)`. */
const baseColumns = (classes: string[]): boolean => classes.some(name => name.startsWith('grid-cols-'))

describe('the layout survives a phone', () => {
  it('finds the templates to check, so a broken glob cannot pass for free', () => {
    expect(templateFiles().length).toBeGreaterThan(30)
  })

  it('names a base column count whenever a grid has responsive ones', () => {
    const offenders: string[] = []
    for (const file of templateFiles()) {
      for (const element of templateElements(templateOf(fs.readFileSync(file, 'utf8')))) {
        if (!has(element.classes, 'grid'))
          continue
        const responsive = responsiveColumns(element.classes)
        if (responsive.length === 0 || baseColumns(element.classes))
          continue
        // `grid-cols-2` at every width needs no base class; a `sm:`/`lg:`-only count does.
        offenders.push(`${path.relative(srcDir, file)}: <${element.tag}> has ${responsive.join(' ')} with no base grid-cols-1`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('never lets a wrapping row refuse to shrink', () => {
    const offenders: string[] = []
    for (const file of templateFiles()) {
      for (const element of templateElements(templateOf(fs.readFileSync(file, 'utf8')))) {
        if (has(element.classes, 'shrink-0') && has(element.classes, 'flex-wrap'))
          offenders.push(`${path.relative(srcDir, file)}: <${element.tag}> is both shrink-0 and flex-wrap`)
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * A title row beside a `shrink-0` action cluster must be allowed to wrap, or the title loses.
   *
   * A flex row is laid out at its items' **min-content** before anything shrinks, and `shrink-0`
   * on the action cluster says that cluster keeps its full width. So the title — the item that
   * can give way — absorbs the whole deficit. `FieldGroup` drew a group heading beside its
   * actions that way; measured in Chromium at 320 px, `Interface` (three actions: Reset name,
   * Revert to stock, Install UI) rendered in a **5 px** box holding 51 px of the word, and the
   * description under it spilled to **304 px tall at 5 px wide**, one word per line.
   * `Destinations` (222 px of actions) was 24 px wide. Every one of those groups was fine from
   * 560 px up, which is why it hid — and `Panel` is the same shape.
   *
   * The rule is the pair, not the component: a row that puts a heading beside an action cluster
   * which will not shrink must also let the row wrap, so the cluster drops below the heading
   * instead of eating it. `PageHeader` already does this.
   */
  it('does not let an action cluster starve the heading beside it', () => {
    const offenders: string[] = []
    for (const file of templateFiles()) {
      const source = templateOf(fs.readFileSync(file, 'utf8'))
      for (const element of templateElements(source)) {
        if (element.tag !== 'header' || !has(element.classes, 'justify-between'))
          continue
        if (!element.body.includes('<h1') && !element.body.includes('<h2') && !element.body.includes('<h3'))
          continue
        // `shrink-0` inside the header is the cluster; without it the row is already flexible.
        if (!/\bshrink-0\b/.test(element.body) || has(element.classes, 'flex-wrap'))
          continue
        offenders.push(`${path.relative(srcDir, file)}: <${element.tag}> puts a heading beside a shrink-0 cluster with no flex-wrap`)
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * A link or button whose only content is an icon has no text to make it big, so its target is
   * whatever box the class list gives it. Every other icon control in the UI is a `size-6`/`size-7`
   * grid or an `AppButton`; the one that was not — the card's "open in a new tab" glyph — was a
   * 14 px target eight pixels from the title link that opens the detail page.
   *
   * 24 px is the floor: below it a thumb misses often enough that the neighbour wins, and a
   * mis-tap that leaves the panel is the expensive kind.
   */
  it('gives an icon-only control a target of at least 24px', () => {
    const SIZES = { 'size-4': 16, 'size-5': 20, 'size-6': 24, 'size-7': 28, 'size-8': 32, 'size-9': 36 }
    const offenders: string[] = []
    for (const file of templateFiles()) {
      for (const element of templateElements(templateOf(fs.readFileSync(file, 'utf8')))) {
        // The element's own body, so a sibling sharing this class list is a different element.
        const iconOnly = /<svg[\s>]|<[A-Z]\w*/.test(element.body) && !element.body.replace(/<[^>]*>|\s/g, '').includes('{{')
        if (!iconOnly)
          continue
        const named = element.classes.map(name => SIZES[name as keyof typeof SIZES]).filter(value => value !== undefined)
        // No size class at all is fine when the icon is padded into a box by `grid place-items-center`;
        // what is not fine is a size that measures the *glyph*, under the floor.
        const biggest = named.length > 0 ? Math.max(...named) : null
        if (biggest !== null && biggest < 24)
          offenders.push(`${path.relative(srcDir, file)}: <${element.tag}> is icon-only in a ${biggest}px box`)
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * A wide table scrolls **inside its own box**, never with the page.
   *
   * The Jobs table has five columns that want 492 px at 320 px wide. Unwrapped, it grew `main` to
   * 508 px, so the whole page scrolled sideways — and a horizontal scroll on `main` moves the page
   * header too. Measured in Chromium 157 after a 188 px scroll: `New job` sat at 60–116 px and the
   * `Jobs` title's left edge at **-172 px**, i.e. the only create control and the page's own name
   * were off screen. `RouteTable` already wraps its table this way.
   *
   * The rule is about the *page* scroller specifically: a component inside a pane may legitimately
   * manage its own overflow, so the scan asks whether a table sits in a `overflow-x-auto` box.
   */
  it('puts a wide table in its own horizontal scroller', () => {
    const WIDE = ['/src/views/JobsView.vue', '/src/components/settings/AccountsSection.vue']
    for (const file of WIDE) {
      const source = fs.readFileSync(path.join(root, '..', '..', 'uis/stock', file), 'utf8')
      expect(source, `${file} must scroll its table in a box`).toContain('overflow-x-auto')
    }
  })

  /**
   * A scroll with no signal is a clipped table.
   *
   * The box above is `overflow-x: auto`, and on a phone its scrollbar is invisible: the Jobs table
   * is 197 px wider than its 288 px box at a 320 px viewport, and its action cell alone is 240 px
   * of it — so `Run now` sat **14 px past the right edge** at rest, and the schedule above it wrapped
   * `0 3 * * *` across two lines into `0 3` / `* * *`. Nothing on the page said either was a scroll
   * away. `scroll-hint-x` paints an edge shadow that appears and disappears with the scroll
   * position, through `background-attachment: local` for the content layers and `scroll` for the
   * box layers — the technique noc-console's `.tblwrap` already uses.
   *
   * The guard is written over the sheet rather than the DOM: it asserts the four-layer declaration
   * and the theme-aware edge token exist, and that every `overflow-x-auto` box in a view or
   * component carries the hint class, so a fifth table cannot ship silent.
   */
  it('gives a horizontally scrolling box a visible edge hint', () => {
    const styles = fs.readFileSync(path.join(root, '..', '..', 'uis/stock', 'src/styles.css'), 'utf8')
    const rule = styles.slice(styles.indexOf('.scroll-hint-x'))
    expect(rule, 'the hint needs four layers').toContain('background-attachment: local, local, scroll, scroll')
    // A hardcoded colour would be invisible in one theme: the light shadow is dark, the dark pale.
    expect(rule, 'the edge must come from a theme token').toContain('var(--scroll-edge)')
    const light = styles.slice(0, styles.indexOf('.dark {'))
    const dark = styles.slice(styles.indexOf('.dark {'))
    expect(light, 'light theme edge token').toContain('--scroll-edge:')
    expect(dark, 'dark theme edge token').toContain('--scroll-edge:')

    // The cover layer must be the ground the scroller is drawn on, not a hardcoded panel: a table
    // directly on the page got a white band down its right edge that hid its last action column.
    expect(styles, 'the cover layer is a variable').toContain('var(--scroll-cover)')
    expect(rule, 'the cover defaults to a panel').toContain('--scroll-cover: var(--panel)')
    expect(styles, 'a page-ground cover exists').toContain('--scroll-cover: var(--page)')

    // Every horizontal scroller in a template opts into it.
    const silent: string[] = []
    for (const file of templateFiles()) {
      const source = fs.readFileSync(file, 'utf8')
      for (const match of source.matchAll(/class="([^"]*\boverflow-x-auto\b[^"]*)"/g)) {
        const classes = match[1] ?? ''
        if (!classes.split(/\s+/).includes('scroll-hint-x'))
          silent.push(`${path.relative(root, file)}: "${classes}"`)
      }
    }
    expect(silent).toEqual([])

    // A scroller drawn straight on the page ground says so, or its cover is the wrong colour.
    const jobs = fs.readFileSync(path.join(root, '..', '..', 'uis/stock', 'src/views/JobsView.vue'), 'utf8')
    expect(jobs, 'the Jobs table sits on the page and needs the page cover').toContain('scroll-hint-page')
  })

  /**
   * A `flex-1` sibling next to a default-flex sibling eats the row, and `truncate` cannot save it.
   *
   * Global settings → Paths put a label+hint block beside a value block. The value block was
   * `flex-1` (`flex-basis: 0`); the label block had the default `flex: 0 1 auto` and sized to its
   * own content, so on a narrow card the label took the **whole** row and the value was squeezed to
   * a 0 px box. `truncate` does not help — an element with no box renders nothing, ellipsis
   * included — while the copy button beside it stayed visible and clickable, so the page offered
   * "copy" for a path it never showed.
   *
   * Measured in Chromium on `/global/settings?section=paths`: at 320 px the Data root value was
   * **0 px** wide holding 252 px of text, Global settings 0 px of 350, and the three workspace rows
   * the same; one row at 390 px still measured 0 px. At 640 px and up every row was fine, which is
   * why it hid.
   *
   * The rule is the shape, not that one component: a row that pairs a label with a `truncate`
   * value must give that value a box at every width. Below `sm` the pair stacks, so the value gets
   * its own line; above it the value takes `flex-1` with the row already wide enough to spare it.
   */
  it('never squeezes a truncated value to a zero-width box beside its label', () => {
    const file = path.join(root, 'src/components/settings/PathsSection.vue')
    const elements = templateElements(templateOf(fs.readFileSync(file, 'utf8')))
    // The value wrapper: the flex child that holds the `truncate` span.
    expect(elements.filter(element => element.classes.includes('truncate')).length, 'the paths rows still show a path').toBeGreaterThan(0)

    // The *row* is what pairs the two halves; a wrapper holding only the value is not a pair.
    const rows = elements.filter(element => element.tag === 'li' && element.body.includes('truncate'))
    expect(rows.length, 'both path lists render rows').toBe(2)

    for (const element of rows) {
      const stacked = has(element.classes, 'flex-col') && element.classes.some(name => name.startsWith('sm:flex-row'))
      // Either the pair stacks on a phone (the value gets a full line), or the value keeps `flex-1`
      // at every width — never `flex-1` alone with no narrow fallback.
      expect(stacked, `<${element.tag}> pairs a label with a truncated value and must stack below sm`).toBe(true)
    }
  })

  /**
   * A bare `flex-1` text block beside a fixed cluster never wraps — it just shrinks to nothing.
   *
   * This is the *other* half of the rule above, and it bit the archive list: a wrapping row put the
   * archive's name block beside `Download` / `Restore` / `Delete`. `flex-1` is `flex-basis: 0`, so
   * the text block asked for **no** room, the pair always fitted on one line, `flex-wrap` never
   * engaged, and the name absorbed the entire deficit. Measured in Chromium with two ordinary
   * archives — `backup-2026-11-16-21-36-13-53.zip` and `…-21-48-03-187.zip`: at 320 px each name sat
   * in a **34 px** box holding 238 px of text, so both painted the same `bac…` and the row gave no
   * way to tell which archive you were about to restore or delete; the `3 KiB · <date>` line beneath
   * spilled to **112 px tall at 34 px wide** (7 lines). At 390 px the name got 104 px and the date 3
   * lines, at 480 px two. From 560 px up every row was correct, which is why it hid.
   *
   * The rule: a `flex-1` block whose job is to hold a `truncate` line must carry a **basis**, so the
   * row wraps when the text can no longer sit beside the cluster. `basis-60` (15rem) is just over
   * the 238 px a full archive name measures — 14rem truncated it by 4 px at 520 px.
   */
  it('never puts a zero-basis truncating block in a wrapping row', () => {
    // In a `flex-wrap` row a zero basis is the whole bug: the block asks for no width, so the pair
    // always fits on one line, the wrap never engages, and the text is squeezed to nothing.
    const offenders: string[] = []
    for (const file of templateFiles()) {
      for (const element of templateElements(templateOf(fs.readFileSync(file, 'utf8')))) {
        if (!has(element.classes, 'flex-wrap') || !element.body.includes('truncate'))
          continue
        /**
         * Any element, not only a `<div>`.
         *
         * The rule was written for a `div` holding an archive name, and that is why it missed the one
         * that shipped: the page title in `shell/TopBar.vue` is an `<h1>`, and `flex-1` gives it
         * `flex-basis: 0`. The action cluster therefore decided how much room the title got, and the
         * title was tuned to English — "Global settings" needed 100 px at 390 px wide and 110 px at
         * 640 px, and fitted both times, while "Globale Einstellungen" needed 126 px and was given
         * 100 px, then **81 px at 640 px** because `sm:flex` adds the search button. A German or
         * Russian title was ellipsised; the English one never was.
         */
        for (const child of templateElements(element.body)) {
          if (!has(child.classes, 'flex-1') || !child.body.includes('truncate'))
            continue
          if (child.classes.some(name => name.startsWith('basis-')))
            continue
          offenders.push(`${path.relative(srcDir, file)}: <${child.tag} class="${child.classes.join(' ')}"> sits in a wrapping row asking for no width`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * A `flex-1` **title** in a flex row needs a basis, whether or not the row wraps.
   *
   * The case above requires `flex-wrap`, which is right for a row that is *supposed* to wrap and wrong
   * for the one that shipped broken: `shell/TopBar.vue`'s header is `flex` with no `flex-wrap`, and its
   * `<h1>` was `flex-1 truncate` — `flex-basis: 0`, so the action cluster beside it decided how much
   * room the title got. That was tuned to English ("Global settings" needs 100 px at 390 px and 110 px
   * at 640 px, and fitted both) and broke every longer language: "Globale Einstellungen" needs 126 px
   * and was given 100 px at 390 px and **81 px at 640 px**, because `sm:flex` brings in the search
   * button at that breakpoint. Measured across all nine languages at seven widths after the fix:
   * no sideways scroll anywhere, tightest fit 83 % (`de` at 320 px).
   *
   * Scoped to a heading because that is where the defect lives and where a basis is always right: a
   * heading that gives way should give way to a *wrapped* line, not to nothing.
   */
  it('gives a flex title a basis, so a longer language is not the one that gives way', () => {
    const offenders: string[] = []
    for (const file of templateFiles()) {
      const source = fs.readFileSync(file, 'utf8')
      for (const element of templateElements(templateOf(source))) {
        if (!has(element.classes, 'flex') || has(element.classes, 'flex-wrap') || has(element.classes, 'flex-col'))
          continue
        for (const child of templateElements(element.body)) {
          if (!['h1', 'h2'].includes(child.tag) || !has(child.classes, 'flex-1'))
            continue
          if (child.classes.some(name => name.startsWith('basis-')))
            continue
          offenders.push(`${path.relative(srcDir, file)}: <${child.tag} class="${child.classes.join(' ')}"> asks for no width in a flex row`)
        }
      }
    }
    expect(offenders, 'a flex title with no basis is sized by its siblings, which was tuned to English').toEqual([])
  })

  /**
   * A translated label in a fixed row must be capped, or the row is sized by whichever language is
   * longest.
   *
   * The TopBar's search button printed `topbar.search` uncapped: 237 px in English, 266 px in German,
   * **302–318 px in French**, because "Rechercher ou exécuter une commande" is 65 px longer than
   * "Search or run a command". The action cluster grows with it, and the page title beside it — a
   * `flex-1` heading — is the element that gives way: it was left 131 px of the 136 px it needs, so
   * French was ellipsised at *every* width while English read in full.
   *
   * Scoped to a `span` inside the TopBar's search button: that is the one translatable string rendered
   * inline in a fixed-height row. A data value truncated with `truncate` is by design and not this rule.
   */
  it('caps the search label so the header is not sized by the longest language', () => {
    const topbar = fs.readFileSync(path.join(root, '..', '..', 'uis/stock/src/components/shell/TopBar.vue'), 'utf8')
    const searchLabel = /<span[^>]*>\{\{ t\('topbar\.search'\) \}\}<\/span>/.exec(topbar)?.[0]
    expect(searchLabel, 'the search label must still be there').toBeTruthy()
    expect(
      searchLabel,
      'the search label has no width cap, so the button grows with its translation and squeezes the page title',
    ).toContain('max-w-')
  })

  it('keeps the archive row wrapping rather than squeezing its name', () => {
    const file = path.join(root, 'src/components/settings/BackupsSection.vue')
    // The archive list is the one that renders a download link per row; the captures list above it
    // has no action cluster, which is why only this row ever lost its name.
    const rows = templateElements(templateOf(fs.readFileSync(file, 'utf8')))
      .filter(element => element.tag === 'li' && element.body.includes('backupDownloadUrl'))
    expect(rows.length, 'the archive list still renders its rows').toBe(1)
    const row = rows[0]!
    expect(has(row.classes, 'flex-wrap'), 'the archive row must be allowed to wrap').toBe(true)
    const name = templateElements(row.body).find(child => child.tag === 'div' && child.body.includes('truncate'))
    expect(name, 'the archive row still pairs its name with its actions').toBeDefined()
    expect(name!.classes.some(cls => cls.startsWith('basis-')), 'the archive name block needs a basis, not a bare flex-1').toBe(true)
  })
})
