import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Both themes keep their quiet text readable, on **every** surface it lands on.
 *
 * The light theme's `--faint` carried the comment "≥4.5:1 on --panel so 11px labels stay readable",
 * and against `--panel` it did: 4.76. But `--faint` also sets 11 px labels that sit on the **page**
 * background — `/global/overview`'s `home-hosted · v0.13.0` and `Host vitals`, a job row's `Edited
 * from browser` — and there it measured **4.13 : 1**, below the 4.5 AA floor for body text. The
 * token was validated against one surface and used on five.
 *
 * So this guard is not "is the token compliant"; it is "is the token compliant where it is used",
 * which is the distinction the comment got wrong. It reads the values out of `styles.css` (a later
 * palette tweak is measured, not assumed) and checks both theme blocks against every surface each
 * one declares.
 */

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8')

/** The declarations of one block: `:root { … }` or `.dark { … }`. */
function block(selector: string): Record<string, [number, number, number]> {
  // The last declaration of each token wins, which is how the cascade reads these files.
  const start = styles.indexOf(`${selector} {`)
  if (start === -1)
    throw new Error(`no ${selector} block in styles.css`)
  const end = styles.indexOf('\n}', start)
  const body = styles.slice(start, end)
  const out: Record<string, [number, number, number]> = {}
  for (const match of body.matchAll(/--([\w-]+):\s*#([0-9a-f]{6})\s*;/gi)) {
    const [, name, hex] = match
    out[name!] = [0, 2, 4].map(index => Number.parseInt(hex!.slice(index, index + 2), 16)) as [number, number, number]
  }
  return out
}

/** WCAG 2.x relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Every surface the theme paints text on. A row's hover tint and the softest line are included. */
const SURFACES = ['page', 'panel', 'panel-2', 'raise', 'hover', 'line-soft'] as const
const AA = 4.5

describe('stock keeps its faint text above AA', () => {
  for (const [theme, selector] of [['light', ':root'], ['dark', '.dark']] as const) {
    const T = block(selector)

    it(`${theme}: --faint is declared`, () => {
      expect(T.faint, `--faint in the ${theme} block`).toBeDefined()
      for (const name of SURFACES) expect(T[name], `--${name} in the ${theme} block`).toBeDefined()
    })

    it(`${theme}: --faint clears 4.5:1 on every surface, not just --panel`, () => {
      const failures: string[] = []
      for (const surface of SURFACES) {
        const ratio = contrast(T.faint!, T[surface]!)
        if (ratio < AA)
          failures.push(`${theme} --faint on --${surface}: ${ratio.toFixed(2)} < ${AA}`)
      }
      expect(failures, 'a token used on five surfaces is validated on five').toEqual([])
    })

    it(`${theme}: --faint still sits below --muted`, () => {
      // Quiet is the point; the fix must not promote the tone into the next one up.
      const panel = T.panel!
      expect(contrast(T.faint!, panel)).toBeLessThan(contrast(T.muted!, panel))
    })
  }

  it('measures the value it replaced, so the guard is not vacuous', () => {
    // `#64748b` against the light page: the failure this test exists for.
    const T = block(':root')
    expect(contrast([0x64, 0x74, 0x8B], T.page!)).toBeLessThan(AA)
    expect(contrast([0x64, 0x74, 0x8B], T.panel!), 'it passed on --panel, which is why it survived').toBeGreaterThan(AA)
  })

  /**
   * The status colours carry text too: a row's `· exit 0`, a `Stopped` chip, a warning line.
   *
   * They were each a shade under AA on the page background (ok 4.41, warn 4.14, danger 4.46) and
   * passed on `--panel` — the same one-surface mistake as `--faint`. Only the two surfaces status
   * text actually lands on are asserted; `--line-soft` is a border and no status text is drawn on it.
   */
  it('light: --ok / --warn / --danger clear 4.5:1 where status text is drawn', () => {
    const T = block(':root')
    const failures: string[] = []
    for (const name of ['ok', 'warn', 'danger'] as const) {
      for (const surface of ['page', 'panel'] as const) {
        const ratio = contrast(T[name]!, T[surface]!)
        if (ratio < AA)
          failures.push(`--${name} on --${surface}: ${ratio.toFixed(2)} < ${AA}`)
      }
    }
    expect(failures, 'a status word in a sentence is body text').toEqual([])
  })
})
