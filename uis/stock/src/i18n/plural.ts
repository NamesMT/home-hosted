/**
 * Plural selection for `tc()`, by CLDR category rather than by message index.
 *
 * The library's built-in rule is "form N is `parts[count]`, else the last" — an English shape, so
 * Russian's `21` and `5` would read the same form. A plain-string message is a language with one
 * form; it is still interpolated, or `{count}` shows literally.
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
