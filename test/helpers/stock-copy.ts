import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Reading the stock UI's English catalogs from a panel-side test.
 *
 * Three panel tests used to assert a piece of UI copy by grepping the `.vue` source for its English
 * text (`test/services/removal-copy.test.ts`, `test/services/dependency-hint.test.ts`,
 * `test/config/head-body-hint.test.ts`). Once the UI translates its strings the literal is gone
 * from the source — it lives in `uis/stock/src/i18n/messages/en/` — and the assertion fails for a
 * reason that has nothing to do with the rule it exists to protect.
 *
 * The durable form is to assert on the *copy itself*, wherever it is stored: the sentence a person
 * reads is what these tests are about. So this resolves a catalog key to its English message, the
 * same value the UI renders, and the tests keep pinning the wording rather than its location.
 *
 * English only, on purpose: the panel ships no other language, and these assertions are about what
 * the shipped stock UI says in its default language.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))
const englishDir = path.join(root, 'uis', 'stock', 'src', 'i18n', 'messages', 'en')

type Message = string | Record<string, string>

function loadEnglish(): Record<string, Message> {
  const catalog: Record<string, Message> = {}
  for (const file of fs.readdirSync(englishDir).filter(name => name.endsWith('.json'))) {
    Object.assign(catalog, JSON.parse(fs.readFileSync(path.join(englishDir, file), 'utf8')))
  }
  return catalog
}

const english = loadEnglish()

/**
 * The English message for `key`, with `{name}` placeholders substituted.
 *
 * Throws rather than returning undefined: a key that no longer exists is a test that would
 * otherwise pass by asserting `undefined` against a loose matcher.
 */
export function stockCopy(key: string, params: Record<string, string> = {}): string {
  const message = english[key]
  if (message === undefined)
    throw new Error(`no English catalog entry for "${key}" — uis/stock/src/i18n/messages/en/`)
  if (typeof message !== 'string') {
    // A plural entry: the caller is asserting on wording, so the `other` form is the one to read.
    const other = message.other
    if (other === undefined)
      throw new Error(`"${key}" is a plural entry with no "other" form`)
    return interpolate(other, params)
  }
  return interpolate(message, params)
}

/** Every English key, for a test that needs to search the copy rather than name it. */
export function stockCopyEntries(): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [key, message] of Object.entries(english))
    out.push([key, typeof message === 'string' ? message : (message.other ?? '')])
  return out
}

function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match)
}
