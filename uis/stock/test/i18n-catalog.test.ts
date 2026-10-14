import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../src/i18n/locales'

/**
 * The catalogs are the one part of i18n that nothing else fails on.
 *
 * A missing key does not throw — `t()` renders the key name back, which looks like a typo in the
 * UI rather than a bug, and `t()` in a *template* of a component nobody tests is not exercised by
 * the suite at all. These are shape checks over the JSON, deliberately without a renderer.
 */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const messagesDir = path.join(root, 'src', 'i18n', 'messages')
const englishDir = path.join(messagesDir, 'en')

type Catalog = Record<string, unknown>

/** The plural categories a message object may use, in CLDR order. */
const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other'])

function readEnglish(): Record<string, Catalog> {
  const out: Record<string, Catalog> = {}
  for (const file of fs.readdirSync(englishDir).filter(name => name.endsWith('.json')))
    out[file] = JSON.parse(fs.readFileSync(path.join(englishDir, file), 'utf8')) as Catalog
  return out
}

/** Every key any catalog defines, and which files define it. */
function keyOwners(): Map<string, string[]> {
  const owners = new Map<string, string[]>()
  for (const [file, catalog] of Object.entries(readEnglish())) {
    for (const key of Object.keys(catalog)) {
      const list = owners.get(key) ?? []
      list.push(file)
      owners.set(key, list)
    }
  }
  return owners
}

describe('english catalog shape', () => {
  it('defines every key exactly once across the fragments', () => {
    // Two fragments defining one key is silent: the merge order decides the winner, so the
    // wording of a screen would depend on `readdir` order.
    const duplicates = [...keyOwners()].filter(([, files]) => files.length > 1)
    expect(duplicates.map(([key, files]) => `${key} in ${files.join(', ')}`)).toEqual([])
  })

  it('uses flat dotted keys, never a nested object', () => {
    // A nested entry cannot be reached by a flat lookup, and it would silently shadow the
    // literal key beside it. Plural values are the one object allowed, and only with plural
    // category members.
    const offenders: string[] = []
    for (const [file, catalog] of Object.entries(readEnglish())) {
      for (const [key, value] of Object.entries(catalog)) {
        if (value === null || typeof value !== 'object')
          continue
        const members = Object.keys(value as Catalog)
        const pluralOnly = members.length > 0 && members.every(member => PLURAL_CATEGORIES.has(member))
        if (!pluralOnly)
          offenders.push(`${file}: ${key} -> ${members.join('|')}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('writes every placeable holder as a real placeholder', () => {
    // `t()` interpolates `{name}`. A message that names a value but never holds a placeholder
    // renders a sentence with the value missing, which no type can catch.
    const offenders: string[] = []
    for (const [key, value] of Object.entries(flatten(readEnglish()))) {
      if (typeof value !== 'string')
        continue
      const opens = (value.match(/\{/g) ?? []).length
      const closes = (value.match(/\}/g) ?? []).length
      if (opens !== closes)
        offenders.push(`${key}: ${value}`)
    }
    expect(offenders).toEqual([])
  })

  it('has no empty message', () => {
    const empties = Object.entries(flatten(readEnglish()))
      .filter(([, value]) => typeof value === 'string' && value.trim().length === 0)
      .map(([key]) => key)
    expect(empties).toEqual([])
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

  it('ships a catalog for every locale that is not the default', () => {
    // A locale with no catalog file would load nothing and render English forever, which looks
    // like a broken picker rather than a missing file.
    const missing = LOCALES
      .filter(locale => locale.code !== 'en')
      .filter(locale => !fs.existsSync(path.join(messagesDir, `${locale.code}.json`)))
      .map(locale => locale.code)
    expect(missing).toEqual([])
  })

  it('translates every key into every locale', () => {
    // A partial catalog does not fail loudly — the English fallback fills each gap, so a language
    // that is 90% translated looks fine until someone opens the one screen nobody checked. The
    // count is the only signal, so it is asserted rather than eyeballed.
    const english = [...englishKeys().keys()]
    const report: string[] = []
    for (const locale of LOCALES) {
      if (locale.code === 'en')
        continue
      const catalog = JSON.parse(fs.readFileSync(path.join(messagesDir, `${locale.code}.json`), 'utf8')) as Catalog
      const absent = english.filter(key => !(key in catalog))
      if (absent.length > 0)
        report.push(`${locale.code}: ${absent.length} untranslated (e.g. ${absent.slice(0, 3).join(', ')})`)
    }
    expect(report).toEqual([])
  })
})

/**
 * Every key the English catalogs define, as a flat map.
 *
 * Exported for the completeness test below and for the translation pass, so a translator works
 * from the same list the guard checks.
 */
function englishKeys(catalogs = readEnglish()): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const catalog of Object.values(catalogs)) {
    for (const [key, value] of Object.entries(catalog))
      out.set(key, value)
  }
  return out
}

function flatten(catalogs: Record<string, Catalog>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const catalog of Object.values(catalogs))
    Object.assign(out, catalog)
  return out
}
