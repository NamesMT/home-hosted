import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { templateRegion } from '../helpers/strip-comments'
import { uiNames } from '../support/uis'

/**
 * Every interactive control, in **either** UI, must have an accessible name.
 *
 * A screen reader announces an unnamed button as "button" and an unnamed combobox as "combobox, <its
 * value>" — the control cannot be identified at all. This is not a stylistic rule: it is the difference
 * between a panel someone can use and one they cannot.
 *
 * **The rule existed twice, each covering half of one UI.** `uis/noc-console/test/select-accessible-name.test.ts`
 * checked `<select>`s and then buttons, but only in that UI's own templates; `uis/stock/test/toggle-switch.test.ts`
 * checked the switch component's labelling. Nothing looked at both UIs at once, so a control added to
 * stock was covered by nothing — and stock is the UI that ships in the npm package.
 *
 * Swept in Chromium first, across all eight stock routes and all seven console routes: every control
 * already has a name. That is why this is worth pinning **now** — the failure it prevents is invisible
 * to anyone who can see the icon or read the label.
 *
 * A source scan, because happy-dom computes no accessible name. It accepts every way this codebase names
 * a control: `aria-label`, `aria-labelledby`, `title`, a wrapping `<label>` (which is how a file input and
 * a select are named here), an enclosing `label[for]`, or text of its own.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

function templates(): Array<{ file: string, body: string }> {
  const out: Array<{ file: string, body: string }> = []
  for (const ui of uiNames()) {
    const dir = path.join(root, 'uis', ui, 'src')
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.vue'))
        out.push({ file: path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'), body: templateRegion(fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8')) })
    }
  }
  return out.sort((left, right) => left.file.localeCompare(right.file))
}

/** A control whose own opening tag names it: the three attribute forms, all equally valid. */
function namedByAttribute(opening: string): boolean {
  return /aria-label\s*=/.test(opening)
    || /aria-labelledby\s*=/.test(opening)
    || /\btitle\s*=/.test(opening)
    || /\bv-html\s*=/.test(opening)
}

/** Whether a `<label>` opens before `index` and has not closed by then — an implicit association. */
function insideLabel(body: string, index: number): boolean {
  const before = body.slice(0, index)
  const opens = [...before.matchAll(/<label\b/g)].length
  const closes = [...before.matchAll(/<\/label>/g)].length
  return opens > closes
}

/** Whether an `id` this control carries is the target of some `label[for]` in the same template. */
function namedByFor(body: string, opening: string): boolean {
  const id = /\bid\s*=\s*"([^"]+)"/.exec(opening)?.[1]
  if (id === undefined)
    return false
  return new RegExp(`<label[^>]*\\bfor\\s*=\\s*"${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(body)
}

describe('every interactive control has an accessible name', () => {
  /**
   * The scan must see the controls it claims to guard.
   *
   * Three times on this branch a source scan passed because it matched nothing — `mounted.length`,
   * `declared.size`, and a locale filter that tested an array of objects against a string. Counting is
   * what makes that impossible to miss.
   */
  it('finds the controls in both UIs', () => {
    let selects = 0
    let buttons = 0
    for (const { body } of templates()) {
      selects += [...body.matchAll(/<select\b/g)].length
      buttons += [...body.matchAll(/<button\b|<AppButton\b/g)].length
    }
    expect(selects, 'the scan found no <select> — a broken glob would pass for free').toBeGreaterThan(5)
    expect(buttons, 'the scan found no buttons').toBeGreaterThan(30)
  })

  it('names every select', () => {
    const offenders: string[] = []
    for (const { file, body } of templates()) {
      for (const match of body.matchAll(/<select\b[^>]*>/g)) {
        const opening = match[0]
        const index = match.index ?? 0
        if (namedByAttribute(opening) || insideLabel(body, index) || namedByFor(body, opening))
          continue
        offenders.push(`${file}: ${opening.replace(/\s+/g, ' ').slice(0, 110)}`)
      }
    }
    expect(offenders, 'a select with no accessible name announces only its value').toEqual([])
  })

  /**
   * A **text-like input** needs a name too, and nothing checked it.
   *
   * Verified by planting two bare inputs in `uis/stock/src/views/ZzBad.vue` — `<input type="text">` and
   * `<input type="number">`, each carrying only a `placeholder`. All four assertions passed. A screen reader
   * announces those as "text field" with no name; a `placeholder` is not one, because it disappears on the
   * first keystroke and some readers never announce it.
   *
   * The page's own fields are labelled correctly — `uis/stock/src/components/ui/NumberField.vue` pairs
   * `<label :for="id">` with `:id="id"` — so this guards the *next* one, the bare `<input>` someone writes
   * instead of reaching for the component. Checkboxes, radios, files, ranges, colours, dates and buttons are
   * excluded: each has its own convention here (a wrapping label, a `type` that names it) and several are
   * hidden form plumbing with a `v-model` and no user-facing value.
   */
  it('names every text-like input, where a placeholder is not a name', () => {
    const offenders: string[] = []
    let seen = 0
    for (const { file, body } of templates()) {
      for (const match of body.matchAll(/<input\b[^>]*>/g)) {
        const opening = match[0]
        const index = match.index ?? 0
        // Skip the types whose naming convention is different or which carry no user-facing value.
        if (/type\s*=\s*"(?:checkbox|radio|file|range|color|date|datetime-local|time|month|week|hidden|submit|reset|button|image|search)"/.test(opening))
          continue
        seen += 1
        if (namedByAttribute(opening) || insideLabel(body, index) || namedByFor(body, opening))
          continue
        offenders.push(`${file}: ${opening.replace(/\s+/g, ' ').slice(0, 110)}`)
      }
    }
    // Anti-vacuity: the scan must actually see text-like inputs, or it asserts nothing.
    expect(seen, 'no text-like input found — the scan is stale').toBeGreaterThan(10)
    expect(offenders, 'a named text field announces only "text field"; a placeholder is not a name').toEqual([])
  })

  it('names every button, including an icon-only one added later', () => {
    const offenders: string[] = []
    for (const { file, body } of templates()) {
      for (const match of body.matchAll(/<(?:button|AppButton)\b[^>]*>([\s\S]*?)<\/(?:button|AppButton)>/g)) {
        const opening = /<(?:button|AppButton)\b[^>]*>/.exec(match[0])?.[0] ?? match[0]
        if (namedByAttribute(opening))
          continue
        /**
         * A **wrapper component's** own `<button>` is named by its caller, through a `<slot />`.
         *
         * `AppButton.vue` renders `<button><slot /></button>` — the label is whatever the user of the
         * component writes. Flagging it would be a false positive, and the fix for one is never to
         * "name" the wrapper, because that would override the text every caller passes in.
         */
        if (/<slot\b/.test(match[1] ?? ''))
          continue
        // Text of its own? Tags are stripped, entities count as a glyph a reader hears.
        const inner = (match[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, 'x').trim()
        if (inner.length > 0)
          continue
        // A button named by a sibling `label[for]` is valid HTML, if unusual.
        if (namedByFor(body, opening))
          continue
        offenders.push(`${file}: ${opening.replace(/\s+/g, ' ').slice(0, 110)}`)
      }
    }
    expect(offenders, 'a button with no accessible name announces only "button"').toEqual([])
  })

  /**
   * The file input stock's Interface section uses is named by its wrapping `<label>`, and that is the
   * association a naive scan misses — it looks for `label[for]` and finds nothing.
   *
   * Recorded because it produced a false positive when this rule was first written in Chromium: the
   * control was reported unnamed while the accessibility tree gave it the text of its ancestor label.
   * Asserted here so the convention is documented rather than merely tolerated.
   */
  it('accepts a control named by its wrapping label', () => {
    const files = templates().filter(entry => entry.body.includes('type="file"'))
    expect(files.length, 'no file input anywhere — the scan is stale').toBeGreaterThan(0)
    let wrapping = 0
    for (const { body } of files) {
      for (const match of body.matchAll(/<input[^>]*type\s*=\s*"file"[^>]*>/g)) {
        if (insideLabel(body, match.index ?? 0))
          wrapping += 1
      }
    }
    expect(wrapping, 'a file input is no longer named by a wrapping label — check how it is named now').toBeGreaterThan(0)
  })
})
