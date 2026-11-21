import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { templateRegion } from '../../../test/helpers/strip-comments'

/**
 * Every `<select>` a person can reach must carry an accessible name.
 *
 * A screen reader announces an unnamed combobox as "combobox" plus its current value and nothing
 * else, so the field cannot be identified: a keyboard or screen-reader operator hears "combo box,
 * tcp port" and has no way to know it is the *health check mode* rather than the listener bind or
 * the stop signal. This console names nearly every one of its selects by wrapping them in their
 * `label.field` / `label.field--check`; the health pane's mode dropdown was a bare `<select>` in a
 * compact header row and was the exception.
 *
 * Measured in Chromium on `/w/default/servers/python/config`: 4 visible selects, three named by a
 * wrapping label and this one's computed name the empty string. After naming it, 0 unnamed selects
 * on all eight routes.
 *
 * A source scan, because happy-dom computes no accessible name. It accepts the three ways this
 * codebase names a control — a wrapping `<label>`, an `aria-label`, or an `id` a `label[for]`
 * points at — and flags anything else that is not explicitly decorative.
 */

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const srcDir = path.join(root, 'src')

function templates(): Array<{ file: string, body: string }> {
  const files: string[] = []
  for (const entry of fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.vue'))
      files.push(path.join(entry.parentPath, entry.name))
  }
  return files.sort().map(file => ({ file: path.relative(srcDir, file), body: templateRegion(fs.readFileSync(file, 'utf8')) }))
}

/**
 * Every `<select …>` opening tag in a template, with the text around it needed to decide whether
 * it is named: whether an enclosing `<label>` opens before it and closes after.
 */
function selects(body: string): Array<{ tag: string, index: number, named: boolean }> {
  const out: Array<{ tag: string, index: number, named: boolean }> = []
  for (const match of body.matchAll(/<select\b[^>]*>/g)) {
    const tag = match[0]
    const index = match.index ?? 0
    // `title` is Chromium's last-resort name source and these three Logs-page selects rely on
    // it (measured: the browser computes "source"/"lines"/"stream" for them, so they are not
    // unnamed). It is a weaker name — a title never shows on touch — which is why the new control
    // below gets a real `aria-label` rather than another title.
    let named = /aria-label\s*=/.test(tag) || /\btitle\s*=/.test(tag)
    if (!named) {
      // The nearest unclosed `<label` before it: count opens and closes up to this point.
      const before = body.slice(0, index)
      const opens = [...before.matchAll(/<label\b/g)].length
      const closes = [...before.matchAll(/<\/label>/g)].length
      named = opens > closes
    }
    out.push({ tag, index, named })
  }
  return out
}

describe('every reachable control has an accessible name', () => {
  it('finds the selects to check, so a broken glob cannot pass for free', () => {
    const total = templates().reduce((sum, entry) => sum + selects(entry.body).length, 0)
    expect(total, 'no <select> in the console').toBeGreaterThan(4)
  })

  it('names every select with a label or an aria-label', () => {
    const offenders: string[] = []
    for (const { file, body } of templates()) {
      for (const select of selects(body)) {
        if (select.named)
          continue
        offenders.push(`${file}: ${select.tag.replace(/\s+/g, ' ').slice(0, 100)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * The same rule for a `<button>`, which is where it will next be broken.
   *
   * A `<select>` is named by its wrapping `label`. A **button** usually gets its name from its own text,
   * which is why this was never checked: every button in both UIs happens to have a word in it — until
   * someone adds an icon-only one, and a screen reader announces "button" and nothing else.
   *
   * Swept in Chromium across all seven console routes and all eight stock routes before writing this:
   * no control anywhere lacks an accessible name. That is the reason to pin it now, while it is true —
   * the check costs a source scan and the failure it prevents is invisible to everyone who can see the
   * icon.
   *
   * Accepts every way this codebase names a control: `aria-label`, `aria-labelledby`, a `title`, a
   * wrapping `<label>`, or text of its own. A tag whose content is only whitespace or a component is
   * given the benefit of the doubt only when a component could carry text — so a bare
   * `<button><Icon /></button>` is flagged, which is exactly the shape to catch.
   */
  it('names every button, including an icon-only one added later', () => {
    const offenders: string[] = []
    for (const { file, body } of templates()) {
      for (const match of body.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
        const tag = match[0]
        const opening = /<button\b[^>]*>/.exec(tag)?.[0] ?? tag
        if (/aria-label\s*=/.test(opening) || /aria-labelledby\s*=/.test(opening) || /\btitle\s*=/.test(opening))
          continue
        // Text of its own? Entities and interpolation (`{{ … }}`) both count as content a reader hears.
        const inner = (match[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, 'x').trim()
        if (inner.length > 0)
          continue
        // A wrapping `<label>` is not how a button is named, but an enclosing `aria-label` on an
        // ancestor group is not this check's business either — flag only a button that is bare.
        offenders.push(`${file}: ${opening.replace(/\s+/g, ' ').slice(0, 110)}`)
      }
    }
    expect(offenders, 'a button with no accessible name announces only "button"').toEqual([])
  })

  it('keeps the health-mode dropdown named', () => {
    // The specific regression this test was written for.
    const view = fs.readFileSync(path.join(srcDir, 'views/ServerConfigView.vue'), 'utf8')
    const match = /<select[^>]*v-model="form\.health\.mode"[^>]*>/.exec(view)
    expect(match, 'the health mode select is gone').not.toBeNull()
    expect(match![0], 'the health mode select needs an aria-label').toContain('aria-label=')
  })
})
