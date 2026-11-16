import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stripComments } from '../../../test/helpers/strip-comments'

/**
 * A count a person reads is spelled, never `4 item(s)`.
 *
 * `(s)` is the placeholder an author leaves when they do not want to decide between singular and
 * plural. It is not wrong English exactly — it is *unfinished* English — and it showed up in nine
 * places a user actually sees: the Logs header read `1 server(s)` next to a single server, the
 * workspace settings footer read `1 field(s) → workspace settings`, the restore toast said
 * `restored 1 item(s)`, and the host vitals path count read `1 configured path(s)`.
 *
 * The UI already had the answer and used it in a dozen other places
 * (`{{ groups.length }} workspace{{ groups.length === 1 ? '' : 's' }}`), which is what makes this a
 * defect at all rather than a style preference: the same sentence is spelled two ways on one page,
 * and the `(s)` one is the visible half of a translation the author never finished. noc-console is
 * English-only, so there is no catalog to fall back on and no reason to keep a placeholder.
 *
 * **A unit is not a count.** `timeout (s)`, `cooldown (s)` and `grace (ms)` are parenthesised units
 * and stay exactly as they are; the scan therefore looks for `(s)` only in a run that is *glued to a
 * number the template interpolates*, or to an interpolated count inside a script template literal.
 */

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))

/** Every source file the UI ships, `.vue` templates and script strings alike. */
function sources(): Array<{ file: string, text: string }> {
  const out: Array<{ file: string, text: string }> = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(?:vue|ts)$/.test(entry.name))
        continue
      out.push({ file: path.relative(root, full), text: fs.readFileSync(full, 'utf8') })
    }
  }
  walk(path.join(root, 'src'))
  return out
}

const SHIPPED = sources()

/**
 * A `(s)` that pluralises a count rather than naming a unit.
 *
 * Two spellings reach the DOM and both are read as defects:
 *
 *  - a template interpolation immediately before it — `{{ servers.length }} server(s)`;
 *  - a template literal in script — `` `restored ${n} item(s)` ``.
 *
 * The unit labels (`timeout (s)`, `cooldown (s)`, `every (s)`) are preceded by a word, not a number,
 * so neither pattern matches them; `configured path(s)` is caught because its interpolated number is
 * what the reader sees even though a word sits between.
 */
const COUNT_BEFORE_UNIT = /\{\{[^}]*\}\}[^<>{}\n]*?\(s\)/
const COUNT_IN_TEMPLATE = /\$\{[^}]*\}[^`"'\n]*?\(s\)/

/** A literal `$`, so the plant below is built without writing a `${` that a linter reads as a template. */
const DOLLAR = String.fromCharCode(36)

describe('noc-console spells its counts', () => {
  it('never renders a count as `N thing(s)`', () => {
    const offenders: string[] = []
    for (const { file, text } of SHIPPED) {
      // Comments are stripped: this test's own explanation contains the pattern it forbids.
      const clean = stripComments(text, file)
      const lines = clean.split('\n')
      lines.forEach((line, index) => {
        if (COUNT_BEFORE_UNIT.test(line) || COUNT_IN_TEMPLATE.test(line))
          offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`)
      })
    }
    expect(offenders, 'a count is singular or plural, never `(s)`').toEqual([])
  })

  /**
   * The scan reads both languages it claims to read.
   *
   * A guard that silently stops matching is worse than none: it reports `[]` and looks green. These
   * two plants prove the template half and the script half each still fire, in the same shapes the
   * real defects had.
   */
  it('catches a planted template count and a planted script count', () => {
    expect(COUNT_BEFORE_UNIT.test('<span>{{ rows.length }} route(s)</span>'), 'template half').toBe(true)
    const planted = `const m = \`restored ${DOLLAR}{n} item(s)\``
    expect(COUNT_IN_TEMPLATE.test(planted), 'script half').toBe(true)
    // And leaves a unit alone, which is the mistake that would make the guard unusable.
    expect(COUNT_BEFORE_UNIT.test('<span class="field__label">timeout (s)</span>'), 'a unit is not a count').toBe(false)
  })
})
