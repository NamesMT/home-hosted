/**
 * The UI's one i18n instance, and the only place a component should read translations from.
 *
 * Four deliberate choices, each of which the stock UI depends on:
 *
 * 1. **A module singleton, not `app.use()`.** Components call `useI18n()` from here, which reads
 *    the instance directly. The library's composable needs `app.provide`, and this repo's
 *    component tests mount a single SFC with no plugins — they would all break. A module-level
 *    instance needs no provide/inject, and `t()` stays reactive inside a render function because
 *    the library tracks its own revision ref.
 * 2. **English is eager, every other catalog is a lazy chunk.** Nine catalogs is real weight for a
 *    panel that usually serves one language; `import.meta.glob` code-splits the rest, and
 *    `setLocale` awaits the chunk before switching so no half-translated frame is painted.
 * 3. **Keys are flat** (`nav.settings`): one catalog entry per string, resolved by exact match, so
 *    a literal key can never be shadowed by a nested tree.
 * 5. **The choice is browser-local** (`hh.locale`, beside `hh.theme`). The login page has no
 *    session, so a panel-side setting could not be read there; a per-browser choice is also what
 *    a shared panel wants.
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

/**
 * Switches the UI's language, loading its catalog first.
 *
 * Resolves once the catalog is in place, so a caller can await it and never paint a frame of the
 * previous language's strings under the new choice.
 */
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
 * The locale to start in, and the work to get there. Called once from `main.ts` before mount, so
 * the first paint is already in the right language.
 *
 * Never rejects. A catalog is a network fetch — a stale `index.html` after a redeploy, an offline
 * home server, a proxy that drops the chunk — and a rejection here would mean the app never
 * mounts, which is a blank page with no way back. English is already in the bundle, so the worst
 * case is an English panel.
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

/**
 * A string for `key`, in the active language.
 *
 * `params` interpolate `{name}` placeholders; `fallback` is used for a key no catalog has, which
 * keeps a half-translated build readable instead of showing the raw key.
 */
export function t(key: string, params?: Record<string, unknown>, fallback?: string): string {
  const value = i18n.global.t(key, params as never, fallback ?? null)
  return typeof value === 'string' ? value : String(value ?? '')
}

/**
 * A plural-aware string: the form comes from the language's own plural categories (see `plural.ts`).
 *
 * A language that inflects writes a message object (`{ one, few, many, other }`); one that does not
 * writes a plain string with `{count}`.
 *
 * The message is resolved here rather than through the library's `tc()`, because that call forwards
 * only `{count}` to the plural rule — a message with a second placeholder (`{count} of {total}`)
 * would render `{total}` literally. `resolveTranslations()` is the library's own dump of what `t()`
 * can see, already layering the fallback language, so this reads the same string `t()` would.
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
