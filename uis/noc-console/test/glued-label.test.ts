import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cssRules, templateRegion } from '../../../test/helpers/strip-comments'

/**
 * Two inline elements that belong on one line need a gap the compiler will not eat.
 *
 * The Vue template compiler trims whitespace at a tag boundary, so
 *
 *     <span class="id">{{ server.id }}</span>
 *     <span class="dim"> {{ server.config.label }}</span>
 *
 * renders as `pythonPython server`. Measured in Chromium against a running panel: the gap between
 * the id's right edge and the label's left edge was **0.00 px**, and the text range around the label
 * started at exactly the id's `right` (237.20 = 237.20). The same shape sat in three more places —
 * a job id and its label (`nightlyEdited from browser`), an account id and its label, and a route's
 * host and its id — so it is a class, not one cell.
 *
 * The stock UI already writes the gap at its call sites (`ml-1.5` on a job label, `gap-2` on a
 * notice's hint) and one of its components carries the explanation: *"`ml-1` rather than a space in
 * the markup: the template compiler trims whitespace at a tag boundary, so `> {{ hint }}` rendered as
 * `with.Change`"*. This console spells it as one `.label` utility rather than a margin at each cell,
 * because four cells are one rule.
 *
 * A source scan, because happy-dom has no layout engine and a mount can only read the markup — the
 * space it would find is the one the compiler removes.
 */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const srcDir = path.join(root, 'src')
const styles = fs.readFileSync(path.join(srcDir, 'styles.css'), 'utf8')

/** Every `.vue` under `src/`, template region only. */
function templates(): Array<{ file: string, body: string }> {
  const files: string[] = []
  for (const entry of fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.vue'))
      files.push(path.join(entry.parentPath, entry.name))
  }
  return files.sort().map(file => ({ file: path.relative(root, file), body: templateRegion(fs.readFileSync(file, 'utf8')) }))
}

/**
 * A `<span>` whose first child is a space, then a mustache, then its close — the whole of what the
 * compiler drops. `<span>{{ x }}</span>` asks for no gap and is fine; the defect is asking for one
 * in the space the compiler trims.
 */
const LEADING_SPACE_INTERPOLATION = /<span\b[^>]*>[ \t]+\{\{[^}]*\}\}<\/span>/g

describe('a label set beside a row’s identity is spaced by layout, not by a template space', () => {
  it('never relies on a leading space inside a tag to separate two inline elements', () => {
    const offenders: string[] = []
    for (const { file, body } of templates()) {
      for (const match of body.matchAll(LEADING_SPACE_INTERPOLATION))
        offenders.push(`${file}: ${match[0].replace(/\s+/g, ' ').slice(0, 80)}`)
    }
    expect(offenders, 'use the .label utility (or a margin) for the gap').toEqual([])
  })

  it('ships the .label utility the cells use', () => {
    const rule = cssRules(styles).find(entry => entry.selectors.includes('.label:not(.chip)'))
    expect(rule, 'the .label utility must exist').toBeDefined()
    expect(rule!.body).toMatch(/margin-left:\s*[\d.]+rem/)
  })

  it('gives a badge inside a field label the same gap', () => {
    const rule = cssRules(styles).find(entry => entry.selectors.includes('.field__label .label'))
    expect(rule, 'a secret name and its state badge share a .field__label').toBeDefined()
    expect(rule!.body).toMatch(/margin-left:\s*[\d.]+rem/)
  })

  /**
   * The four cells that carried the defect name the utility, so a refactor that drops the class is
   * caught even while the markup stays otherwise identical.
   */
  it.each([
    ['components/ServerList.vue', 'server.config.label'],
    ['views/JobsView.vue', 'job.label'],
    ['components/AccountsSection.vue', 'account.label'],
    ['components/SecretEnvBlock.vue', '— not set'],
    ['components/JobSecretEnvBlock.vue', '— not set'],
  ])('%s spaces %s', (file, needle) => {
    const source = fs.readFileSync(path.join(srcDir, file), 'utf8')
    const line = source.split('\n').find(entry => entry.includes(needle) && entry.includes('<span'))
    expect(line, `${file} must still render ${needle}`).toBeDefined()
    expect(line, `${file} must space ${needle} with .label`).toMatch(/class="[^"]*\blabel\b/)
  })
})
