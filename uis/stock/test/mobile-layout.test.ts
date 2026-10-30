import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { templateRegion } from '../../../test/helpers/strip-comments'

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

/**
 * One element's class list, from its opening tag.
 *
 * A `class` written as a string literal is checked; a bound one (`:class="cn(…)"`) is not, because
 * its value is assembled at render time and a scan would have to evaluate it. Every defect this
 * round found sat in a literal, which is also where a hand-written row starts.
 */
function literalClasses(template: string): { tag: string, classes: string[] }[] {
  const found: { tag: string, classes: string[] }[] = []
  // Scanned by hand rather than by one regex: the tag name and the attribute run share the
  // characters `[\w-]`, and any pattern that lets them both claim those backtracks
  // polynomially on a minified template. `slice` cannot.
  for (const chunk of template.split('<').slice(1)) {
    const name = /^[a-z][a-z0-9-]*/.exec(chunk)?.[0]
    if (name === undefined)
      continue
    // The attributes end at the first `>` outside a quoted value.
    let end = name.length
    let quote = ''
    for (; end < chunk.length; end++) {
      const char = chunk[end]!
      if (quote !== '') {
        if (char === quote)
          quote = ''
        continue
      }
      if (char === '"' || char === '\'') {
        quote = char
        continue
      }
      if (char === '>')
        break
    }
    const attrs = chunk.slice(name.length, end)
    // `(?<!:)` skips `:class`, so only a literal class list is read.
    const classAttr = /(?<![\w:.-])class="([^"]*)"/.exec(attrs)
    if (classAttr === null)
      continue
    found.push({ tag: name, classes: classAttr[1]!.split(/\s+/).filter(Boolean) })
  }
  return found
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
      for (const element of literalClasses(templateOf(fs.readFileSync(file, 'utf8')))) {
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
      for (const element of literalClasses(templateOf(fs.readFileSync(file, 'utf8')))) {
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
      const template = templateOf(fs.readFileSync(file, 'utf8'))
      for (const element of literalClasses(template)) {
        // The element's tag must close with an `svg` and hold nothing else.
        const close = template.indexOf(`</${element.tag}>`, template.indexOf(element.classes.join(' ')))
        const opening = template.lastIndexOf('<', template.indexOf(element.classes.join(' ')))
        if (close === -1 || opening === -1)
          continue
        const body = template.slice(opening, close)
        const iconOnly = /<svg[\s>]|<[A-Z]\w*/.test(body) && !body.replace(/<[^>]*>|\s/g, '').includes('{{')
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
})
