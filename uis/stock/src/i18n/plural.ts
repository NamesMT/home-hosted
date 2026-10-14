/**
 * Plural selection for `tc()`, correct per language rather than per message index.
 *
 * `@i18n-micro/vue`'s built-in rule is "form N is `parts[count]`, else the last" — an English
 * shape. Russian needs `one`/`few`/`many`, so `21` must read "21 яблоко" (CLDR `one`) while
 * `5` reads "5 яблок" (`many`); index-by-count gives both the same form. `Intl.PluralRules`
 * already knows every language's categories, so this resolves the category and reads it off
 * the message object.
 *
 * A plain-string message is a language with one form (Chinese, Japanese, Korean, Vietnamese) or a
 * message that never inflects. It still gets interpolated: returning it raw left a literal
 * `{count}` on screen, which is how this was caught.
 */
import type { Getter, Params, PluralFunc, Translations } from '@i18n-micro/vue'

function interpolate(template: string, params: Params, count: number): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (key === 'count')
      return String(count)
    const value = params[key]
    return value === undefined ? match : String(value)
  })
}

// One rules object per language: `Intl.PluralRules` construction is not free and this runs per render.
const rules = new Map<string, Intl.PluralRules>()

export const pluralRules: PluralFunc = (key, count, params, locale, getter: Getter) => {
  const raw = getter(key) as Translations | string | null
  if (raw === null || raw === undefined)
    return null
  if (typeof raw === 'string')
    return interpolate(raw.split('|')[0]!.trim(), params ?? {}, count)

  let rule = rules.get(locale)
  if (rule === undefined) {
    rule = new Intl.PluralRules(locale)
    rules.set(locale, rule)
  }
  const category = rule.select(count)
  const form = raw[category] ?? raw.other
  return typeof form === 'string' ? interpolate(form, params ?? {}, count) : null
}
