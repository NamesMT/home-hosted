import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The quiet tones are quiet, not invisible.
 *
 * `--faint` is not decoration in this UI. It sets a job's label, a log pane's `0 ln` counter, a
 * row's `· exit 0`, the status line's `ws` / `sel` keys and the nav's `g s` chords — text a person
 * reads, at 9.5–13 px, on the darkest surfaces the theme has. At its old `#55616f` it measured
 * **2.42 : 1** against `--panel-3` and **3.10 : 1** against `--ink`, which is roughly half the
 * 4.5 : 1 AA floor for body text. On a real monitor that is not "subtle", it is a smear.
 *
 * The numbers here are computed from the token block in `styles.css` rather than written down, so a
 * later palette tweak is measured instead of assumed. `test/shared/ui-tap-targets.test.ts` is the
 * precedent: the check lives with the value it guards.
 */

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8')

/** Every `--token: #rrggbb;` declared in the sheet. */
function tokens(): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {}
  for (const match of styles.matchAll(/--([\w-]+):\s*#([0-9a-f]{6})\s*;/gi)) {
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

const T = tokens()
/** Every surface the theme paints text on. `panel-3` is the lightest, so it is the binding one. */
const SURFACES = ['ink', 'ink-2', 'panel', 'panel-2', 'panel-3'] as const
const AA = 4.5

describe('noc-console keeps its quiet text readable', () => {
  it('declares the tokens this guard reads', () => {
    for (const name of [...SURFACES, 'faint', 'dim', 'text', 'text-hi']) expect(T[name], `--${name} is declared`).toBeDefined()
  })

  /**
   * Both quiet tones clear AA on every surface they can land on.
   *
   * `--faint` is the one that failed; `--dim` is asserted alongside it because the two are a pair —
   * a later change that lifts one without the other is how the hierarchy collapses silently.
   */
  it('clears 4.5:1 on every surface for --faint and --dim', () => {
    const failures: string[] = []
    for (const name of ['faint', 'dim'] as const) {
      for (const surface of SURFACES) {
        const ratio = contrast(T[name]!, T[surface]!)
        if (ratio < AA)
          failures.push(`--${name} on --${surface}: ${ratio.toFixed(2)} < ${AA}`)
      }
    }
    expect(failures, 'quiet text still has to be readable').toEqual([])
  })

  /**
   * The three tones stay three distinct steps.
   *
   * The first attempt at this fix lifted `--faint` to the smallest value that cleared AA, which put
   * it 0.33 from `--dim` — a visual hierarchy that existed in the palette and would have vanished
   * on screen. Ordering plus a minimum separation is what keeps `--faint` quiet *and* legible.
   */
  it('keeps faint < dim < text as visibly separated steps', () => {
    const ink = T.ink!
    const order = (['faint', 'dim', 'text'] as const).map(name => contrast(T[name]!, ink))
    expect(order[0]!, 'faint is the quietest').toBeLessThan(order[1]!)
    expect(order[1]!, 'dim is quieter than body text').toBeLessThan(order[2]!)
    // 1.5 : 1 of separation is what the original palette had between faint and dim (3.10 -> 5.65).
    expect(order[1]! - order[0]!, 'faint and dim are told apart').toBeGreaterThan(1.5)
  })

  it('measures the values it replaced, so the guard is not vacuous', () => {
    // The pre-fix pair, as literals: this is what the test above would have caught.
    expect(contrast([0x55, 0x61, 0x6F], T['panel-3']!)).toBeLessThan(AA)
    expect(contrast([0x55, 0x61, 0x6F], T.ink!)).toBeLessThan(AA)
  })
})
