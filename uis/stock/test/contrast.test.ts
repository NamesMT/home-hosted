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

/**
 * The `*-soft` tints of one theme block, as the RGB they are and the alpha they are laid down at.
 *
 * `block` above reads `#rrggbb` only, because that is what the surfaces are; a tint is
 * `rgb(R G B / a)`, so it needs its own reader or the guard below would silently see nothing.
 */
function softTints(selector: string): Record<string, { rgb: [number, number, number], alpha: number }> {
  const start = styles.indexOf(`${selector} {`)
  if (start === -1)
    throw new Error(`no ${selector} block in styles.css`)
  const body = styles.slice(start, styles.indexOf('\n}', start))
  const out: Record<string, { rgb: [number, number, number], alpha: number }> = {}
  for (const match of body.matchAll(/--([\w-]+)-soft:\s*rgb\((\d+\s+\d+\s+\d+)\s*\/\s*([\d.]+)\)/gi)) {
    const [, name, channels, alpha] = match
    const [r, g, b] = channels!.trim().split(/\s+/).map(Number)
    out[name!] = { rgb: [r!, g!, b!], alpha: Number(alpha) }
  }
  return out
}

/** One colour laid over another at `alpha`, the way the compositor reads a tint. */
function composite(fg: [number, number, number], alpha: number, bg: [number, number, number]): [number, number, number] {
  return [0, 1, 2].map(i => Math.round(fg[i]! * alpha + bg[i]! * (1 - alpha))) as [number, number, number]
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

/**
 * Where a **tinted box** sits: every panel surface, but not `--line-soft`, which is a border
 * hairline rather than an area text is drawn on. A 10 % tint over a 1 px line is not a surface.
 */
const TINT_SURFACES = ['page', 'panel', 'panel-2', 'raise', 'hover'] as const
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

  /**
   * A status tone is also painted **on its own tint**, and that was the surface nobody measured.
   *
   * `SystemNotices` and the proxy's notices are one box: `bg-warn-soft text-warn`. A tone tuned to
   * clear the page by a hair does not clear a 10 % layer of *itself* over the page — the tint is
   * the same hue the text already is, so it eats the margin. Measured in Chromium across
   * page/panel/panel-2/raise/hover, the worst case in the light theme was accent **4.17**, ok 3.99,
   * warn 3.94, danger 3.92, info 4.36 — and the dark theme's accent **3.83** and danger 4.44,
   * which the first pass at this file never looked at because only `--faint` was asserted there.
   * The failing text was the notice's own title (`No engine installed`, `A port below 1024 needs a
   * privileged bind`), i.e. the one line in the box that has to be read.
   *
   * So the tones are fitted against the tint **and** the plain surfaces at once, in both themes,
   * and the values are read from the sheet so a later palette tweak is measured rather than assumed.
   */
  for (const [theme, selector] of [['light', ':root'], ['dark', '.dark']] as const) {
    it(`${theme}: every status tone clears 4.5:1 on its own tint, on every surface`, () => {
      const T = block(selector)
      const soft = softTints(selector)
      const failures: string[] = []
      for (const name of ['accent', 'ok', 'warn', 'danger', 'info'] as const) {
        const tint = soft[name]
        expect(tint, `${name}-soft in the ${theme} block`).toBeDefined()
        for (const surface of TINT_SURFACES) {
          const base = T[surface]!
          const painted = composite(tint.rgb, tint.alpha, base)
          const onTint = contrast(T[name]!, painted)
          const onPlain = contrast(T[name]!, base)
          if (onTint < AA)
            failures.push(`${theme} --${name} on --${name}-soft/--${surface}: ${onTint.toFixed(2)} < ${AA}`)
          // The dark theme's accent and danger were *also* under AA on the plain surfaces.
          if (onPlain < AA)
            failures.push(`${theme} --${name} on --${surface}: ${onPlain.toFixed(2)} < ${AA}`)
        }
      }
      expect(failures, 'a notice title is the one line in its box that must be read').toEqual([])
    })
  }

  it('measures the tint it replaced, so the guard is not vacuous', () => {
    // The tones this test exists for, against their own tint over the light page.
    const page = block(':root').page!
    for (const [tone, rgb] of [['accent', [0x2F, 0x5F, 0xE0]], ['ok', [0x15, 0x7D, 0x3B]], ['warn', [0xA0, 0x5C, 0x09]], ['danger', [0xCD, 0x2F, 0x22]]] as const) {
      const painted = composite(rgb as [number, number, number], 0.1, page)
      expect(contrast(rgb as [number, number, number], painted), `${tone} on its own tint`).toBeLessThan(AA)
    }
  })
})
