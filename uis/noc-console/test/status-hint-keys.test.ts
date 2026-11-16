import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The status bar's shortcut hint must describe **this page**, not the console in general.
 *
 * It used to be one hard-coded sentence — `j k move · s start · x stop · r restart · l logs ·
 * e edit · / filter · ? keys` — rendered on every route. Only `ServersView` implements those
 * keys. Measured in Chromium by pressing each key on each route and diffing the DOM:
 * `/global/overview`, `/global/settings`, `/w/default/jobs`, `/w/default/settings`, `/proxy` and
 * the config page answered **none** of them, while `/w/default/logs` answered `/`, `v` and `R`
 * — two of which the bar never named. The console is keyboard-first; a hint that teaches a key
 * which does nothing is worse than a shorter hint, and an undocumented working key is
 * undiscoverable.
 *
 * A source scan, because happy-dom has no layout engine and the bar's whole output is what a
 * mount would have to reproduce. It reads both sides: the keys each view registers with
 * `useKeyHints`, and the keys its `useKeyHandler` actually answers.
 *
 * The pairing is what makes it honest. A view that adds a `case 'q':` without adding the hint
 * has an undiscoverable key; a view that lists a key it never handles has a lying one.
 */

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const srcDir = path.join(root, 'src')
const APP = fs.readFileSync(path.join(srcDir, 'App.vue'), 'utf8')

/** Every `<view>.vue` that registers a key handler, with its template body. */
function views(): Array<{ file: string, source: string }> {
  const out: Array<{ file: string, source: string }> = []
  for (const entry of fs.readdirSync(path.join(srcDir, 'views'), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.vue'))
      continue
    const file = path.join(srcDir, 'views', entry.name)
    out.push({ file: path.relative(srcDir, file), source: fs.readFileSync(file, 'utf8') })
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * Keys the **shell** answers on every route, so a view may list them without handling them.
 *
 * `App.vue` implements `/` (focus the page's `[data-filter]` field) and `a` (open the add-server
 * sheet) itself, after the views get first refusal. They are therefore legitimately part of a
 * page's hint even though no view's `switch` names them — the same reason `?` is always listed.
 */
const SHELL_KEYS = new Set(['/', 'a'])

/**
 * The single-key cases a view's `useKeyHandler` answers.
 *
 * Reads the `case '<key>':` labels of the handler's `switch`, which is the shape every view in
 * this console uses. `Enter` is excluded on purpose: it is the shell's own "open the selected
 * row", listed once in the overlay, not a per-page letter a person needs told.
 */
function handledKeys(source: string): string[] {
  const start = source.indexOf('useKeyHandler(')
  if (start === -1)
    return []
  // The switch that belongs to this handler: everything up to the next top-level `})`.
  const end = source.indexOf('\n})', start)
  const body = source.slice(start, end === -1 ? undefined : end)
  const keys = [...body.matchAll(/case '([^']+)':/g)]
    .map(match => match[1]!)
    .filter(key => key !== 'Enter')
  return [...new Set(keys)]
}

/** The keys a view declares for the status bar through `useKeyHints`. */
function declaredKeys(source: string): string[] {
  const start = source.indexOf('useKeyHints([')
  if (start === -1)
    return []
  const end = source.indexOf('\n])', start)
  const body = source.slice(start, end === -1 ? undefined : end)
  return [...body.matchAll(/keys: \[([^\]]*)\]/g)]
    .flatMap(match => [...match[1]!.matchAll(/'([^']+)'/g)].map(inner => inner[1]!))
}

describe('the status bar names the shortcuts this page answers', () => {
  it('renders the registered hints rather than a fixed sentence', () => {
    // The defect: a literal key-by-key sentence in the shell, identical on every route.
    expect(APP, 'the shell must not carry a fixed list of per-page keys').not.toMatch(/<kbd class="kbd">j<\/kbd><kbd class="kbd">k<\/kbd> move/)
    expect(APP, 'the bar reads the registry').toContain('currentKeyHints()')
  })

  it('finds the views that register a handler, so a broken glob cannot pass for free', () => {
    const withHandlers = views().filter(view => view.source.includes('useKeyHandler('))
    // `ServersView` and `LogsView` are the two today; a third would be checked too.
    expect(withHandlers.length, 'no view registers a key handler').toBeGreaterThanOrEqual(2)
  })

  it('declares a hint for every key a view handles, and handles every key it declares', () => {
    const problems: string[] = []
    for (const view of views()) {
      const handled = handledKeys(view.source)
      if (handled.length === 0)
        continue
      const declared = declaredKeys(view.source)
      for (const key of handled) {
        if (!declared.includes(key))
          problems.push(`${view.file}: handles '${key}' but the status hint never names it`)
      }
      for (const key of declared) {
        if (!handled.includes(key) && !SHELL_KEYS.has(key))
          problems.push(`${view.file}: the status hint names '${key}', which neither this view nor the shell handles`)
      }
    }
    expect(problems).toEqual([])
  })

  it('gives a view that handles keys a registry entry to render', () => {
    for (const view of views()) {
      if (!view.source.includes('useKeyHandler('))
        continue
      expect(view.source, `${view.file} handles keys without declaring any hints`).toContain('useKeyHints([')
    }
  })

  /**
   * A view without a key handler must not leave the bar blank — `?` is the shell's own key and
   * the overlay is how every other key is discoverable, so it is always listed.
   */
  it('always offers the help key, even where the page has no shortcuts of its own', () => {
    const hintBlock = APP.slice(APP.indexOf('status__hint'))
    expect(hintBlock.slice(0, 2000), 'the bar always names `?`').toContain('<kbd class="kbd">?</kbd> keys')
    // …and it is not inside a `v-if` that hides it on pages without view hints.
    expect(hintBlock.slice(0, 2000)).not.toMatch(/v-if="keyHints\.length > 0"><kbd class="kbd">\?<\/kbd>/)
  })
})
