import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCsvData } from 'spreadsheet-i18n'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../src/i18n/locales'

/**
 * The catalogs are the one part of i18n that nothing else fails on.
 *
 * A missing key does not throw — `t()` renders the key name back, which looks like a typo in the
 * UI rather than a bug, and `t()` in a *template* of a component nobody tests is not exercised by
 * the suite at all. These are shape checks, deliberately without a renderer.
 *
 * They read the **CSV**, the source of truth, not the generated JSON. A generated file cannot drift
 * from the sheet it came from; the sheet is where a translator's mistake lives, and one missing cell
 * there is what silently falls back to English.
 */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const sheetsDir = path.join(root, 'i18n', 'sheets')
const generatedDir = path.join(root, 'i18n', 'generated')

type Catalog = Record<string, unknown>

/** One sheet row, with the file it came from: the key column, then one column per locale. */
type SheetRow = Record<string, string> & { __sheet: string }

/** The sheet filenames, without their extension. */
function sheetNames(): string[] {
  return fs.readdirSync(sheetsDir).filter(name => name.endsWith('.csv')).map(name => name.slice(0, -4)).sort()
}

/** Every row of every sheet, tagged with its sheet so a guard can name where a key lives. */
function readSheet(): SheetRow[] {
  const rows: SheetRow[] = []
  for (const name of sheetNames()) {
    const file = path.join(sheetsDir, `${name}.csv`)
    // `parseCsvData` is the library's own reader; `delimiter: undefined` asks it to auto-detect.
    const { data } = parseCsvData({ csvString: fs.readFileSync(file, 'utf8'), delimiter: undefined, logName: `${name}.csv` })
    for (const row of data as Record<string, string>[])
      rows.push({ ...row, __sheet: name })
  }
  return rows
}

/**
 * The sheet a key belongs in, per the rule `i18n/sheets/README.md` states: the key's own prefix,
 * one level deeper for the three prefixes large enough to shard.
 */
const DEEP_PREFIXES = new Set(['settings', 'proxy', 'views'])
function homeSheet(key: string): string {
  const segments = key.split('.')
  return segments[0] !== undefined && DEEP_PREFIXES.has(segments[0]) && segments.length > 1
    ? `${segments[0]}.${segments[1]}`
    : segments[0]!
}

/** The generated catalog for `code`, with the fix named when a clone has none yet. */
function readGenerated(code: string): Catalog {
  const file = path.join(generatedDir, `${code}.json`)
  if (!fs.existsSync(file))
    throw new Error(`missing ${path.relative(root, file)} — run \`pnpm run build:locales\``)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Catalog
}

/** The sheet's `KEY` column, split into the key itself and its plural category when it has one. */
function splitKey(raw: string): { key: string, category: string | null } {
  const match = /^(.*)\[(\w+)\]$/.exec(raw)
  return match === null ? { key: raw, category: null } : { key: match[1]!, category: match[2]! }
}

/** The English message for a key, folding plural rows back into the object the catalog holds. */
function readEnglish(): Catalog {
  const catalog: Catalog = {}
  const plurals = new Map<string, Record<string, string>>()
  for (const row of readSheet()) {
    const raw = String(row.KEY ?? '')
    if (raw.length === 0)
      continue
    const { key, category } = splitKey(raw)
    const value = String(row.en ?? '')
    if (category === null) {
      catalog[key] = value
      continue
    }
    const forms = plurals.get(key) ?? {}
    forms[category] = value
    plurals.set(key, forms)
  }
  for (const [key, forms] of plurals)
    catalog[key] = forms
  return catalog
}

describe('the sheets', () => {
  it('defines every key exactly once across all sheets', () => {
    // A repeated key is silent and *worse* than in one file: the library merges sheets in glob
    // order, so the last one wins and the wording depends on filenames rather than on anything
    // anyone decided. Verified against the library, not assumed.
    const seen = new Map<string, string[]>()
    for (const row of readSheet()) {
      const raw = String(row.KEY ?? '')
      if (raw.length === 0)
        continue
      seen.set(raw, [...(seen.get(raw) ?? []), row.__sheet])
    }
    const duplicates = [...seen]
      .filter(([, sheets]) => sheets.length > 1)
      .map(([key, sheets]) => `${key} in ${sheets.join(', ')}`)
    expect(duplicates).toEqual([])
  })

  it('keeps every key in the sheet its own prefix names', () => {
    // The rule from `i18n/sheets/README.md`. Without this a key lands wherever it was typed, and
    // "which file is this string in" stops having an answer.
    const offenders: string[] = []
    for (const row of readSheet()) {
      const key = String(row.KEY ?? '').split('[')[0]!
      if (key.length === 0)
        continue
      const home = homeSheet(key)
      if (row.__sheet !== home)
        offenders.push(`${key} is in ${row.__sheet}.csv, belongs in ${home}.csv`)
    }
    expect(offenders).toEqual([])
  })

  it('keeps every sheet small enough to read whole', () => {
    // Why the sheets exist: one 462 KB file was returned in full by a single read (~118K tokens).
    // A budget here stops that creeping back once a sheet grows past the point of being usable.
    const BUDGET_KB = 32
    const offenders: string[] = []
    for (const name of sheetNames()) {
      const kb = fs.statSync(path.join(sheetsDir, `${name}.csv`)).size / 1024
      if (kb > BUDGET_KB)
        offenders.push(`${name}.csv is ${kb.toFixed(0)} KB (budget ${BUDGET_KB} KB) — shard it further`)
    }
    expect(offenders).toEqual([])
  })

  it('gives every sheet a column for every supported locale', () => {
    // A sheet missing a locale's column drops those strings from that catalog, and the picker then
    // shows a language with English showing through.
    const offenders: string[] = []
    for (const name of sheetNames()) {
      const rows = readSheet().filter(row => row.__sheet === name)
      const header = Object.keys(rows[0] ?? {})
      const absent = LOCALES.filter(locale => !header.includes(locale.code)).map(locale => locale.code)
      if (absent.length > 0)
        offenders.push(`${name}.csv: ${absent.join(', ')}`)
    }
    expect(offenders).toEqual([])
  })

  it('never puts a comma-separated list in the KEY column', () => {
    // `parseCsvData` treats extra columns as fields, so a stray comma in a key silently becomes
    // an unnamed column rather than an error.
    const offenders = readSheet()
      .map(row => String(row.KEY ?? ''))
      .filter(key => key.includes(','))
    expect(offenders).toEqual([])
  })

  it('balances the placeholders in every cell', () => {
    // A translator dropping a brace renders a sentence with the value missing, and no type can
    // see it. Checked per cell rather than per key, so the locale that broke it is named.
    const offenders: string[] = []
    for (const row of readSheet()) {
      for (const locale of LOCALES) {
        const value = String(row[locale.code] ?? '')
        // An absent category has no message to balance.
        if (value.length === 0)
          continue
        const opens = (value.match(/\{/g) ?? []).length
        const closes = (value.match(/\}/g) ?? []).length
        if (opens !== closes)
          offenders.push(`${row.KEY} [${locale.code}]: ${value}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps each translation’s placeholders the same as the English', () => {
    // The drift this sheet exists to make visible: a translation that renames a placeholder
    // renders the raw `{name}` at runtime, because `t()` only substitutes what it is given.
    const rows = readSheet()
    const englishOf = new Map<string, string>()
    for (const row of rows)
      englishOf.set(String(row.KEY ?? ''), String(row.en ?? ''))

    const offenders: string[] = []
    for (const row of rows) {
      const raw = String(row.KEY ?? '')
      const { key, category } = splitKey(raw)
      // A category English does not fill is compared against `other`, which is the form its
      // readers and ours both fall back to for that category.
      const english = englishOf.get(raw) || (category === null ? '' : englishOf.get(`${key}[other]`) ?? '')
      const en = new Set(english.match(/\{(\w+)\}/g) ?? [])
      for (const locale of LOCALES) {
        if (locale.code === 'en')
          continue
        // An empty cell is a category this language does not have, not a translation that
        // dropped a placeholder — the emptiness check owns that case.
        if (String(row[locale.code] ?? '').length === 0)
          continue
        const found = new Set(String(row[locale.code] ?? '').match(/\{(\w+)\}/g) ?? [])
        const missing = [...en].filter(name => !found.has(name))
        const extra = [...found].filter(name => !en.has(name))
        if (missing.length > 0 || extra.length > 0)
          offenders.push(`${raw} [${locale.code}]: missing ${missing.join(',') || '—'} / extra ${extra.join(',') || '—'}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('fills every message, or provides the `other` its runtime falls back to', () => {
    // A blank plural cell means "this language has no such category" — Spanish `many` is only
    // reachable at a million, and reads fine from `other`. Blank is therefore only safe when
    // `other` is filled, because `pluralRules` resolves a missing category as `raw.other`.
    // A blank *non-plural* cell renders nothing at all.
    const rows = readSheet()
    const others = new Set<string>()
    for (const row of rows) {
      const { key, category } = splitKey(String(row.KEY ?? ''))
      if (category === 'other' && String(row.en ?? '').trim().length > 0)
        others.add(key)
    }

    const offenders: string[] = []
    for (const row of rows) {
      const { key, category } = splitKey(String(row.KEY ?? ''))
      for (const locale of LOCALES) {
        if (String(row[locale.code] ?? '').trim().length > 0)
          continue
        if (category === null)
          offenders.push(`${row.KEY} [${locale.code}] renders nothing`)
        else if (!String(row[`${key}[other]` as never] ?? '').length && !others.has(key))
          offenders.push(`${row.KEY} [${locale.code}] and no \`other\` to fall back to`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('keys the code names statically', () => {
  /**
   * A key written as a literal in source is a promise the catalog has to keep.
   *
   * `meta.titleKey` is the sharpest case: TopBar renders it through `t()`, so a typo shows the key
   * name in the page header — and no type connects the router's string to the JSON. The same goes
   * for the label tables in `lib/status.ts`, which `t()` reads at render time.
   */
  it('resolves every titleKey the router declares', () => {
    const router = fs.readFileSync(path.join(root, 'src', 'router.ts'), 'utf8')
    const keys = [...router.matchAll(/titleKey: '([^']+)'/g)].map(match => match[1]!)
    // Anti-vacuity: the router is meant to declare several, and a regex that matched none would
    // make the assertion below pass for the wrong reason.
    expect(keys.length).toBeGreaterThan(4)
    expect(keys.filter(key => !englishKeys().has(key))).toEqual([])
  })

  it('resolves every label key the status tables name', () => {
    const status = fs.readFileSync(path.join(root, 'src', 'lib', 'status.ts'), 'utf8')
    const keys = [...status.matchAll(/labelKey: '([^']+)'/g)].map(match => match[1]!)
    expect(keys.length).toBeGreaterThan(5)
    expect(keys.filter(key => !englishKeys().has(key))).toEqual([])
  })

  /**
   * The command palette's section tables name catalog keys as plain strings, and `t()` renders a
   * missing one back verbatim — so the palette listed `Global setting: settings.backups.title` to
   * anyone searching for the settings page. Four of those keys had never existed; the pages
   * themselves title the same sections from `views.globalSettings.section*`.
   */
  it('resolves every section key the command palette names', () => {
    const palette = fs.readFileSync(path.join(root, 'src', 'components', 'shell', 'CommandPalette.vue'), 'utf8')
    // The two tables are arrays of `['id', 'catalog.key']` pairs.
    const keys = [...palette.matchAll(/\[\s*'[a-z]+',\s*'([^']+)'\s*\]/g)].map(match => match[1]!)
    // Anti-vacuity: a regex that matched nothing would make the assertion below pass for free.
    expect(keys.length).toBeGreaterThan(8)
    expect(keys.filter(key => !englishKeys().has(key))).toEqual([])
  })
})

describe('locale coverage', () => {
  it('has an endonym and an ISO tag for every supported locale', () => {
    for (const locale of LOCALES) {
      expect(locale.name.trim().length, `${locale.code} has no name`).toBeGreaterThan(0)
      // The ISO tag is handed to `Intl`, which rejects a malformed one with a RangeError.
      expect(() => new Intl.DateTimeFormat(locale.iso), `${locale.code} has an invalid iso tag`).not.toThrow()
    }
  })

  it('uses unique locale codes', () => {
    const codes = LOCALES.map(locale => locale.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('generated a catalog for every locale that is not the default', () => {
    // The generated directory is git-ignored, so it is built by `pnpm install`. A locale missing
    // here would load nothing and render English forever, which looks like a broken picker.
    const missing = LOCALES
      .filter(locale => locale.code !== 'en')
      .filter(locale => !fs.existsSync(path.join(generatedDir, `${locale.code}.json`)))
      .map(locale => locale.code)
    expect(missing, 'run `pnpm run build:locales` to generate these').toEqual([])
  })

  it('matches the sheet it was generated from', () => {
    // The JSON is generated, so it cannot drift on its own — but a stale directory can survive an
    // edit to the sheet, and the app renders the JSON. This is what makes that impossible.
    for (const locale of LOCALES) {
      const generated = readGenerated(locale.code)
      const expected: Catalog = {}
      const plurals = new Map<string, Record<string, string>>()
      for (const row of readSheet()) {
        const raw = String(row.KEY ?? '')
        if (raw.length === 0)
          continue
        const { key, category } = splitKey(raw)
        const value = String(row[locale.code] ?? '')
        if (category === null) {
          expected[key] = value
          continue
        }
        // An empty cell is "this language has no such category" — Russian has `few`/`many`,
        // English does not, and the generated object holds only the forms that are filled.
        if (value.length === 0)
          continue
        const forms = plurals.get(key) ?? {}
        forms[category] = value
        plurals.set(key, forms)
      }
      for (const [key, forms] of plurals)
        expected[key] = forms
      expect(generated, `${locale.code} is stale — run \`pnpm run build:locales\``).toEqual(expected)
    }
  })
})

/** Every key the sheet defines, as a flat map. */
function englishKeys(catalogs = readEnglish()): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const [key, value] of Object.entries(catalogs))
    out.set(key, value)
  return out
}
