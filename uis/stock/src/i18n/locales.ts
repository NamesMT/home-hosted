/**
 * The languages this UI ships, and the one place their display names live.
 *
 * `code` is the app's own key (also the catalog filename); `iso` is what `Intl` wants, so a
 * region decides date and number shapes. `name` is the endonym — a language picker a reader
 * cannot read is not a picker, so Spanish reads "Español", never "Spanish".
 */
export interface LocaleMeta {
  code: string
  iso: string
  name: string
}

export const LOCALES: readonly LocaleMeta[] = [
  { code: 'en', iso: 'en-US', name: 'English' },
  { code: 'vi', iso: 'vi-VN', name: 'Tiếng Việt' },
  { code: 'zh-CN', iso: 'zh-CN', name: '简体中文' },
  { code: 'ja', iso: 'ja-JP', name: '日本語' },
  { code: 'es', iso: 'es-ES', name: 'Español' },
  { code: 'ko', iso: 'ko-KR', name: '한국어' },
  { code: 'ru', iso: 'ru-RU', name: 'Русский' },
  { code: 'fr', iso: 'fr-FR', name: 'Français' },
  { code: 'de', iso: 'de-DE', name: 'Deutsch' },
] as const

export const DEFAULT_LOCALE = 'en'

/** Where the choice is kept. Browser-local, beside `hh.theme`: the login page has no session. */
export const LOCALE_STORAGE_KEY = 'hh.locale'

const BY_CODE = new Map(LOCALES.map(locale => [locale.code, locale]))

export function localeMeta(code: string): LocaleMeta | undefined {
  return BY_CODE.get(code)
}

export function isSupportedLocale(code: string): boolean {
  return BY_CODE.has(code)
}

/**
 * The closest supported language for a tag, or `null`.
 *
 * `navigator.language` is `vi`, `zh-Hans-CN`, `pt-BR`; the catalogs are keyed more coarsely.
 * A region-specific request falls back to its base language (`zh-Hans-CN` → `zh-CN`), which is
 * why `zh` is matched by prefix rather than by equality.
 */
export function matchLocale(tag: string): string | null {
  if (tag.length === 0)
    return null
  const lower = tag.toLowerCase()
  const exact = LOCALES.find(locale => locale.code.toLowerCase() === lower)
  if (exact !== undefined)
    return exact.code
  const base = lower.split('-')[0]!
  // `zh-CN` also answers to plain `zh`; every other code is already base-level.
  const byBase = LOCALES.find(locale => locale.code.toLowerCase() === base || locale.code.toLowerCase().split('-')[0] === base)
  return byBase?.code ?? null
}
