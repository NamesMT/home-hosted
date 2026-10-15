/**
 * The UI's one i18n instance, and the only place a component reads translations from.
 *
 * A module singleton, never `app.use()`: the component tests mount one SFC with no plugins, so
 * there is no `app.provide` to inject from. English is eager because it is the fallback; the other
 * eight catalogs are lazy chunks. Keys are flat — exact match, so no key is shadowed by a tree.
 */
import type { Translations } from '@i18n-micro/vue'
import { createI18n } from '@i18n-micro/vue'
import { DEFAULT_LOCALE, isSupportedLocale, LOCALE_STORAGE_KEY, localeMeta, LOCALES, matchLocale } from './locales'
import { pluralRules } from './plural'

type Catalog = Record<string, unknown>

/** The English fragments, eager: the fallback language must exist before the first render. */
const englishFragments = import.meta.glob<{ default: Catalog }>('./messages/en/*.json', { eager: true })
/** Every other catalog, lazy — this is what code-splits them. */
const catalogLoaders = import.meta.glob<{ default: Catalog }>('./messages/*.json')

const english: Catalog = {}
for (const fragment of Object.values(englishFragments))
  Object.assign(english, fragment.default)

const i18n = createI18n({
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  defaultLocale: DEFAULT_LOCALE,
  plural: pluralRules,
  missingWarn: import.meta.env.DEV,
  messages: { [DEFAULT_LOCALE]: english as Translations },
  locales: LOCALES.map(locale => ({ ...locale })),
})

const loaded = new Set<string>([DEFAULT_LOCALE])
const inFlight = new Map<string, Promise<void>>()

function readStored(): string | null {
  try {
    const value = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (value !== null && isSupportedLocale(value))
      return value
  }
  catch {
    // Private mode: fall through to the browser's own preference.
  }
  return null
}

/** What the browser asks for, when nothing is stored. */
function detected(): string {
  const tags = typeof navigator === 'undefined'
    ? []
    : [...(navigator.languages ?? []), navigator.language].filter((tag): tag is string => typeof tag === 'string')
  for (const tag of tags) {
    const match = matchLocale(tag)
    if (match !== null)
      return match
  }
  return DEFAULT_LOCALE
}

/** Loads one catalog once; concurrent callers share the in-flight import. */
async function loadCatalog(code: string): Promise<void> {
  if (loaded.has(code))
    return
  const running = inFlight.get(code)
  if (running !== undefined)
    return running
  const importer = catalogLoaders[`./messages/${code}.json`]
  if (importer === undefined)
    return
  const task = importer()
    .then((module) => {
      // `merge: true` layers the catalog over English, so a key a translation has not reached yet
      // still reads as English rather than as its own key name.
      i18n.global.addTranslations(code, module.default as Translations, true)
      loaded.add(code)
    })
    .finally(() => inFlight.delete(code))
  inFlight.set(code, task)
  return task
}

function applyDocumentLanguage(code: string): void {
  if (typeof document === 'undefined')
    return
  document.documentElement.lang = localeMeta(code)?.iso ?? code
}

/** Switches the language, loading its catalog first so no half-translated frame is painted. */
export async function setLocale(code: string): Promise<void> {
  if (!isSupportedLocale(code) || code === i18n.global.locale.value)
    return
  // A switch that cannot load its catalog keeps the current language rather than throwing into a
  // caller's `void` — the picker shows the language it actually got.
  try {
    await loadCatalog(code)
  }
  catch {
    return
  }
  i18n.global.locale.value = code
  applyDocumentLanguage(code)
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, code)
  }
  catch {
    // Storage is optional; the session still follows the choice.
  }
}

/**
 * The locale to start in. Never rejects: the catalog is a network fetch, and a rejection here
 * would skip the mount and leave a blank page. English is bundled, so the worst case is English.
 */
export async function initLocale(): Promise<void> {
  const code = readStored() ?? detected()
  try {
    await loadCatalog(code)
  }
  catch {
    // English is eager and always present; fall through to it.
    applyDocumentLanguage(DEFAULT_LOCALE)
    return
  }
  if (code !== DEFAULT_LOCALE)
    i18n.global.locale.value = code
  applyDocumentLanguage(code)
}

/** A string for `key`. `params` fill `{name}`; `fallback` covers a key no catalog has. */
export function t(key: string, params?: Record<string, unknown>, fallback?: string): string {
  const value = i18n.global.t(key, params as never, fallback ?? null)
  return typeof value === 'string' ? value : String(value ?? '')
}

/**
 * A plural-aware string; the form comes from the language's plural categories (see `plural.ts`).
 *
 * Resolved through `resolveTranslations()` rather than the library's `tc()`, which forwards only
 * `{count}` to the plural rule and would render a second placeholder literally.
 */
export function tc(key: string, count: number, params?: Record<string, unknown>): string {
  const values = { ...params, count }
  const message = (i18n.global.resolveTranslations() as Record<string, unknown>)[key]
  if (message === undefined)
    return t(key, values, key)
  return pluralRules(key, count, values, currentLocale(), () => message) ?? t(key, values, key)
}

/** The active language code. */
export function currentLocale(): string {
  return i18n.global.locale.value
}

/** Test seam: put the singleton back to English between cases. */
export function __resetLocaleForTests(): void {
  i18n.global.locale.value = DEFAULT_LOCALE
}
