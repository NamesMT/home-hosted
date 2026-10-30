import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cssRules } from '../helpers/strip-comments'

/**
 * A tap-target floor is a rule about every control, so it is one stylesheet both UIs import —
 * and this scan is what keeps the next author from re-declaring a smaller one.
 *
 * Measured in Chromium against a real panel: the noc-console's start/stop/restart/edit row was
 * four 22×20 px buttons, `sign out` was 57×20, and the switch was a 32×18 track with no hit
 * area beyond it. On a 390 px touch viewport those are misses, and beside a dense action row a
 * miss is the wrong action. The floor is one file (`uis/tap-targets.css`) rather than a patch at
 * each of ~30 call sites.
 *
 * happy-dom has no layout engine, so a mount cannot measure any of this. What it can read is the
 * shape that produced it, which is why these are source rules:
 *
 *  - both UIs import the shared floor — a UI that stops importing it silently loses the rule;
 *  - a class the floor sizes (`.btn--icon`) does not pin its own `min-width` under the floor —
 *    that is exactly how the console's 22 px icon buttons survived the shared rule;
 *  - the floor's own two numbers are 24 px and 44 px, and the 44 px tier is gated on
 *    `pointer: coarse` rather than a width, so a desktop window is not restyled.
 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const floorPath = path.join(repoRoot, 'uis/tap-targets.css')
const UIS = ['noc-console', 'stock'] as const

function read(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

/**
 * Comments and quoted strings are blanked by the shared reader (`test/helpers/strip-comments.ts`),
 * because this stylesheet is a corpus that breaks a regex: `.probe::after { content: '/*' }` opened
 * a "comment" that ran to the next `/*` and deleted every rule between them — a `.btn--icon` pinned
 * under the floor stayed green. A rule is parsed, not found by string search.
 */
function declaredPx(source: string, selector: string, property: 'min-width' | 'min-height'): number[] {
  const values: number[] = []
  for (const rule of cssRules(source)) {
    if (!rule.selectors.includes(selector))
      continue
    const match = new RegExp(`(?<![\\w-])${property}\\s*:\\s*(-?[\\d.]+)px`).exec(rule.body)
    if (match?.[1] !== undefined)
      values.push(Number(match[1]))
  }
  return values
}

/** The rules inside one `@media` tier, by its condition — the 44 px tier is asked for by name. */
function rulesInTier(source: string, condition: string): string {
  return cssRules(source)
    .filter(rule => rule.media.includes(condition))
    .map(rule => `${rule.selectors.join(', ')} {${rule.body}}`)
    .join('\n')
}

describe('every control has a thumb-sized target', () => {
  it('finds the floor file the UIs share', () => {
    expect(fs.existsSync(floorPath), `missing ${floorPath}`).toBe(true)
  })

  it('is imported by both UIs, not one', () => {
    const missing: string[] = []
    for (const ui of UIS) {
      const css = read(path.join(repoRoot, 'uis', ui, 'src', 'styles.css'))
      if (!css.includes('tap-targets.css'))
        missing.push(`uis/${ui}/src/styles.css does not import ../../tap-targets.css`)
    }
    expect(missing).toEqual([])
  })

  it('states the decided numbers: 24 px at normal density, 44 px on a coarse pointer', () => {
    const css = read(floorPath)
    expect(css).toMatch(/--hh-tap:\s*24px/)
    expect(css).toMatch(/--hh-tap-icon:\s*24px/)
    // The 44 px tier must be the coarse-pointer one, or a desktop window gets restyled for a
    // thumb and the rule stops meaning "touch".
    const coarse = rulesInTier(css, '(pointer: coarse)')
    expect(coarse, 'no @media (pointer: coarse) block').not.toBe('')
    expect(coarse).toMatch(/--hh-tap:\s*44px/)
    expect(coarse).toMatch(/--hh-tap-icon:\s*44px/)
  })

  /**
   * The defect this replaces: the console's `.btn--icon` pinned `min-width: 22px` for itself, so
   * the shared `min-width: var(--hh-tap-icon)` never applied to it and four row buttons shipped
   * at 22 px on a phone. A class the floor sizes may not re-declare a smaller number.
   */
  it('never lets a UI re-pin a control class under the 24px floor', () => {
    const offenders: string[] = []
    for (const ui of UIS) {
      const css = read(path.join(repoRoot, 'uis', ui, 'src', 'styles.css'))
      for (const property of ['min-width', 'min-height'] as const) {
        for (const value of declaredPx(css, '.btn--icon', property)) {
          if (value < 24)
            offenders.push(`uis/${ui}/src/styles.css: .btn--icon { ${property}: ${value}px } is under the 24px floor`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * A control whose only content is a glyph has no text to make it big, so the floor has to
   * name it. The two shapes the floor covers are a `<button>`/`<a>` holding nothing but an
   * `<svg>`, and the console's `.btn--icon` (whose "icon" is a character). A third shape would
   * need a rule here too — this asserts the floor still names both.
   */
  it('sizes the two icon-control shapes both UIs render', () => {
    const css = read(floorPath)
    expect(css).toMatch(/button:not\(\[role='switch'\]\):has\(>\s*svg:only-child\)/)
    expect(css).toMatch(/a:has\(>\s*svg:only-child\)/)
    expect(css).toMatch(/\.btn--icon/)
  })
})

/**
 * A file input is two targets, and the smaller one is the button.
 *
 * The floor's first version excluded `input[type='file']`, so the one control whose *button* is the
 * only thing to tap was the only one under the bar — measured at 390 px with a coarse pointer:
 * 366×19 in noc-console, 328×39.6 in stock. `::file-selector-button` cannot be measured by
 * happy-dom, so it is pinned as the shape that produces the size.
 */
describe('the file input', () => {
  const floor = read(floorPath)

  it('is covered by the floor, and so is its selector button', () => {
    expect(floor).toContain('input[type=\'file\']')
    expect(floor).toContain('::file-selector-button')
    // It must not be excluded from the generic rule any more — that exclusion is the defect.
    expect(floor).not.toMatch(/input:not\(\[type='checkbox'\]\).*not\(\[type='file'\]\)/)
  })
})
