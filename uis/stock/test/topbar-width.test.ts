import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { templateRegion } from '../../../test/helpers/strip-comments'
import { templateElements } from '../../../test/helpers/template-render'

/**
 * A fixed-width action cluster in the top bar is wider than a 320 px phone.
 *
 * Measured in Chromium against the built panel at 320 px, with the tap-target floor from
 * `uis/tap-targets.css` applied (`--hh-tap-icon: 44px` under `pointer: coarse`): the header's
 * action group was `flex shrink-0` holding four 44 px targets plus the workspace trigger's own
 * `max-w-36` (96 px), which is 246 px beside a 44 px menu button and the header's 24 px of
 * padding — **326 px in a 320 px viewport**. `header.scrollWidth` read 326 and the page title,
 * the only flexible child, collapsed to **0 px**: a phone showed no page name at all, and the
 * last control sat 6 px past the edge.
 *
 * happy-dom has no layout engine, so a mount cannot measure this — the same reason
 * `mobile-layout.test.ts` is a source scan. The rules below are the two shapes that produced it:
 *
 *  - a cluster whose width is its content's (`shrink-0`) inside a row that must fit, and
 *  - a trigger whose label is always rendered, so its own width cannot yield.
 *
 * The fix: the cluster shrinks, and the workspace trigger's label appears at `360px` and up.
 * These assertions are about those two declarations, not about one component's styling.
 */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const shellDir = path.join(root, 'src', 'components', 'shell')
const has = (classes: string[], name: string): boolean => classes.includes(name)

/** The component's template, comments blanked by the shared reader. */
function source(name: string): string {
  return templateRegion(fs.readFileSync(path.join(shellDir, name), 'utf8'))
}

describe('the top bar fits a 320 px phone', () => {
  it('lets the action cluster shrink rather than pinning its content width', () => {
    // The one cluster: the div that holds the palette, connection, theme and account controls.
    // Read by its class *tokens*, not by the text `class="…"`, so a bound or reordered attribute is
    // the same row. The innermost row holding the palette is the cluster, so a decoy or an enclosing
    // wrapper is not mistaken for it.
    const rows = templateElements(source('TopBar.vue'))
      .filter(element => element.tag === 'div' && has(element.classes, 'items-center') && element.body.includes('topbar.search'))
      .sort((a, b) => a.body.length - b.body.length)
    expect(rows.length, 'the action cluster is there to measure').toBeGreaterThan(0)
    const classes = rows[0]!.classes
    expect(classes).toContain('min-w-0')
    expect(classes).toContain('shrink')
    expect(classes).not.toContain('shrink-0')
  })

  it('hides the workspace label below 360 px, so the trigger can give way', () => {
    // The span carrying the workspace's name: it must be hidden by default and shown at 360px.
    const labels = templateElements(source('WorkspacePicker.vue'))
      .filter(element => element.tag === 'span' && element.body.includes('selected?.label'))
    expect(labels, 'the workspace label is one span').toHaveLength(1)
    expect(labels[0]!.classes).toContain('hidden')
    expect(labels[0]!.classes).toContain('min-[360px]:inline')
    // Shown unconditionally again would re-create the 326 px row.
    expect(labels[0]!.classes).not.toContain('inline')
  })
})
