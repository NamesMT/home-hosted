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
})
