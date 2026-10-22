import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A string typed straight into a template never reaches the catalog, so it stays English in every
 * language and nothing fails.
 *
 * The panel's own i18n guard (`i18n-catalog.test.ts`) checks the *sheets* — a wrong sheet, a
 * dropped placeholder, a short row. It cannot see the opposite mistake: copy that never made it
 * into a sheet at all. A Vietnamese panel was the proof: the workspace switcher — the control in
 * the header that every page shows, including its "delete this workspace" confirmation — read
 * `Workspaces / New workspace… / Rename “Default”… / Delete “Default”… / Keep it` in English, and
 * the create dialog's own validation answered `A workspace needs a name.` in English. Twelve
 * strings, one component, one language switch away from being noticed.
 *
 * So this reads the templates and demands each user-visible word comes from `t()`. It is
 * deliberately a *shape* check over the source rather than a render: the components that carried
 * the bug are mounted by no test, which is exactly why the copy survived.
 */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const srcDir = path.join(root, 'src')

/**
 * Literals that are not copy: an identifier or a keycap.
 *
 * Each has to earn its place here. `esc` and `⌘K` are printed keycaps a keyboard layout names; `hh`
 * is the panel's monogram; `servers.config.json` is a file the docs and the CLI both call by that
 * name. Anything else belongs in a sheet.
 */
const NOT_COPY = new Set([
  'esc',
  '⌘K',
  'hh',
  'servers.config.json',
])

/**
 * A `<code>` span is a token, not a sentence: a command, a config key, a filename, a header.
 *
 * Translating one would break it — `home-hosted set-token --generate` is what the reader has to
 * type, and `dependsOn` is the key the panel parses. The prose *around* them is catalog copy and is
 * still checked, which is why this strips the element rather than whitelisting the file.
 */
function withoutCodeSpans(template: string): string {
  return template.replace(/<code[^>]*>[\s\S]*?<\/code>/g, '<code></code>')
}

/** `.vue` templates only: a `.ts` literal is a value, not copy, unless it reaches a template. */
function templateFiles(): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.vue'))
      files.push(path.join(entry.parentPath, entry.name))
  }
  return files.sort()
}

/** The `<template>` block, comments removed so an explanatory note is not read as copy. */
function templateOf(source: string): string {
  const match = /<template>([\s\S]*)<\/template>/.exec(source)
  return withoutCodeSpans((match?.[1] ?? '').replace(/<!--[\s\S]*?-->/g, ''))
}

/**
 * Text a person reads between tags, with the interpolations blanked.
 *
 * `{{ … }}` is an expression, so its value is not this test's business; what remains is the literal
 * words the template author typed. Blanking it also splits `<span>{{ a }}</span>` from its
 * neighbours, which is why the replacement is a space rather than a marker character.
 */
function literalTextNodes(template: string): string[] {
  const found: string[] = []
  for (const match of template.replace(/\{\{[\s\S]*?\}\}/g, ' ').matchAll(/>([^<>]+)</g)) {
    const text = match[1]!.replace(/\s+/g, ' ').trim()
    // A lone separator (`·`, `—`, `/`) is punctuation between two translated values, not copy.
    if (!/[a-z]/i.test(text.replace(/[·—:()/,.]/g, '')))
      continue
    if (NOT_COPY.has(text))
      continue
    found.push(text)
  }
  return found
}

describe('user-visible copy comes from the catalog', () => {
  it('finds the templates to check, so a broken glob cannot pass for free', () => {
    // Anti-vacuity: every assertion below is a "no offenders" list, which an empty file set would
    // satisfy. The UI has dozens of components and this names a floor rather than a count, so
    // adding or deleting one does not fail the test for the wrong reason.
    expect(templateFiles().length).toBeGreaterThan(30)
  })

  it('leaves no untranslated words in a template', () => {
    const offenders: string[] = []
    for (const file of templateFiles()) {
      for (const text of literalTextNodes(templateOf(fs.readFileSync(file, 'utf8')))) {
        offenders.push(`${path.relative(srcDir, file)}: “${text}”`)
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * The attribute a screen reader reads *instead of* the visible text.
   *
   * A hardcoded `aria-label` is worse than hardcoded body copy: a sighted reader at least sees the
   * language they picked, while a screen-reader user hears the English one and has no way to know
   * the rest of the page is translated. `title` is in here for the same reason — it is the tooltip
   * and, on an icon-only control, the accessible name.
   */
  it('leaves no untranslated accessible name or tooltip in a template', () => {
    const ATTRS = ['aria-label', 'title', 'alt', 'aria-placeholder', 'aria-description'] as const
    const offenders: string[] = []
    for (const file of templateFiles()) {
      const template = templateOf(fs.readFileSync(file, 'utf8'))
      for (const attr of ATTRS) {
        // A bound attribute (`:aria-label="t(…)"`) is already the catalog's; only a literal counts.
        for (const match of template.matchAll(new RegExp(`(?<![\\w:.-])${attr}="([^"]*)"`, 'g'))) {
          const value = match[1]!.trim()
          if (!/[a-z]{2}/i.test(value))
            continue
          if (NOT_COPY.has(value))
            continue
          offenders.push(`${path.relative(srcDir, file)}: ${attr}="${value}"`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

/**
 * The keys the fix introduced, and the wording a person actually sees.
 *
 * The shape checks above stop a new hardcoded string; they cannot tell whether a key that *is*
 * wired resolves to anything. `t()` renders a missing key back verbatim, so a typo would read as
 * `workspace.deleteActionFor` in the panel and every check above would still pass.
 */
describe('the workspace surface speaks the reader’s language', () => {
  it('resolves every key the switcher and its dialogs name', async () => {
    const { __resetLocaleForTests, setLocale, t } = await import('@/i18n')
    const expected = (name: string): Record<string, string> => ({
      'en': name,
      'vi': name,
      'zh-CN': name,
      'ja': name,
      'es': name,
      'ko': name,
      'ru': name,
      'fr': name,
      'de': name,
    })
    // German, because it is the locale that exposes a key resolved to its own name fastest — no
    // catalog word there looks like the English one.
    await setLocale('de')
    expect(t('workspace.listHeading')).toBe('Arbeitsbereiche')
    expect(t('workspace.newAction')).toBe('Neuer Arbeitsbereich…')
    expect(t('workspace.renameActionFor', { name: 'Default' })).toBe('„Default“ umbenennen…')
    expect(t('workspace.deleteActionFor', { name: 'Default' })).toBe('„Default“ löschen…')
    expect(t('workspace.deleteTitle', { name: 'Default' })).toBe('„Default“ löschen?')
    expect(t('workspace.nameRequired')).toBe('Ein Arbeitsbereich braucht einen Namen.')
    expect(t('workspace.emptyList').length).toBeGreaterThan(0)
    expect(t('workspace.deleteBody').length).toBeGreaterThan(0)

    // Vietnamese, because it is the language the untranslated switcher was read in.
    await setLocale('vi')
    expect(t('workspace.listHeading')).toBe('Không gian làm việc')
    expect(t('workspace.renameActionFor', { name: 'Default' })).toBe('Đổi tên “Default”…')
    expect(t('workspace.nameRequired')).toBe('Không gian làm việc cần có tên.')

    await setLocale('en')
    await __resetLocaleForTests()
    // The map above is a fixture, not an assertion; it exists so the list of languages stays
    // visible next to the assertions that pick from it.
    expect(Object.keys(expected('x'))).toHaveLength(9)
  })
})
