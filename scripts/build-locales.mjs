#!/usr/bin/env node
/**
 * Builds each UI's catalog JSON from its one `i18n.csv`.
 *
 * The CSV is the source of truth — one row per string, one column per language, so a translation
 * gap is a visibly empty cell rather than a missing file. The JSON it produces is generated and
 * git-ignored; run this after editing the sheet.
 *
 * A plural entry is one row per CLDR category, keyed `<key>[one]`, `<key>[few]`, … and folded back
 * into the message object `@i18n-micro` expects. `spreadsheet-i18n` writes flat strings only, so the
 * fold is here rather than in the library.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { scanConvert } from 'spreadsheet-i18n'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** The CLDR categories, in the order a generated object lists them. */
const CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other']

const PLURAL_KEY = /^(.*)\[(\w+)\]$/

/**
 * Folds `<key>[category]` rows into one message object per key.
 *
 * A key with any category row becomes an object in every language, even one that fills a single
 * form. Collapsing that to a plain string would read the same, but the object is what the catalog
 * holds today, so the generated JSON matches it exactly.
 */
function foldPlurals(catalog) {
  const folded = {}
  const plurals = new Map()

  for (const [key, value] of Object.entries(catalog)) {
    const match = PLURAL_KEY.exec(key)
    if (match === null) {
      folded[key] = value
      continue
    }
    const [, base, category] = match
    const forms = plurals.get(base) ?? {}
    forms[category] = value
    plurals.set(base, forms)
  }

  for (const [base, forms] of plurals) {
    const present = CATEGORIES.filter(category => forms[category] !== undefined)
    folded[base] = Object.fromEntries(present.map(category => [category, forms[category]]))
  }
  return folded
}

/** Every UI that keeps an `i18n/i18n.csv`, in a stable order. */
function uiNames() {
  const uisDir = path.join(root, 'uis')
  return fs.readdirSync(uisDir)
    .filter(name => fs.existsSync(path.join(uisDir, name, 'i18n', 'i18n.csv')))
    .sort()
}

async function build(ui) {
  const sheets = path.join(root, 'uis', ui, 'i18n')
  const outDir = path.join(sheets, 'generated')

  fs.rmSync(outDir, { recursive: true, force: true })
  await scanConvert({
    outDir,
    // Flat keys are the catalog's convention, and the plural rows have to keep their exact names.
    keyStyle: 'flat',
    // The default rewrites a space before `!?:;` into a U+00A0. French wants that space, but it is
    // a typographic choice for the sheet to make, not something to inject into the committed CSV.
    replacePunctuationSpace: false,
  }, sheets)

  let keys = 0
  const files = fs.readdirSync(outDir).filter(name => name.endsWith('.json')).sort()
  for (const file of files) {
    const full = path.join(outDir, file)
    const catalog = foldPlurals(JSON.parse(fs.readFileSync(full, 'utf8')))
    keys = Math.max(keys, Object.keys(catalog).length)
    // `JSON.stringify` with two spaces, so a generated file diffs readably if it is ever inspected.
    fs.writeFileSync(full, `${JSON.stringify(catalog, null, 2)}\n`)
  }

  console.log(`[locales] ${ui}: ${files.length} catalogs, ${keys} keys each`)
}

const requested = process.argv.slice(2)
const targets = requested.length > 0 ? requested : uiNames()
if (targets.length === 0) {
  console.error('[locales] no UI with an i18n/i18n.csv was found')
  process.exit(1)
}
for (const ui of targets)
  await build(ui)
