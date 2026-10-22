// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { __resetLocaleForTests, currentLocale, setLocale, t, tc } from '@/i18n'
import { DEFAULT_LOCALE, LOCALES, matchLocale } from '@/i18n/locales'

describe('i18n store', () => {
  beforeEach(() => __resetLocaleForTests())

  it('resolves a flat English key and interpolates', () => {
    expect(t('nav.workspaceSettings')).toBe('Workspace settings')
    expect(t('theme.label', { theme: 'dark' })).toBe('Theme: dark')
  })

  it('falls back to the supplied text for an unknown key', () => {
    expect(t('nope.missing', {}, 'Fallback')).toBe('Fallback')
  })
})

describe('locale catalogue', () => {
  it('covers the requested languages', () => {
    expect(LOCALES.map(l => l.code)).toEqual(['en', 'vi', 'zh-CN', 'ja', 'es', 'ko', 'ru', 'fr', 'de'])
  })

  it('matches a browser tag to the closest supported language', () => {
    expect(matchLocale('vi')).toBe('vi')
    expect(matchLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(matchLocale('ja-JP')).toBe('ja')
    expect(matchLocale('pt-BR')).toBeNull()
  })

  it('leaves the default locale English', () => {
    expect(DEFAULT_LOCALE).toBe('en')
  })
})

describe('reactivity', () => {
  beforeEach(() => __resetLocaleForTests())

  it('re-renders a component when the locale changes', async () => {
    const C = defineComponent({ setup: () => () => h('span', { class: 'x' }, t('nav.workspaceSettings')) })
    const w = mount(C)
    expect(w.find('.x').text()).toBe('Workspace settings')
    await setLocale('vi')
    await nextTick()
    expect(w.find('.x').text()).toBe('Cài đặt không gian làm việc')
    expect(currentLocale()).toBe('vi')
  })

  it('interpolates {count} through tc() for a plain-string message', () => {
    // A plain string has no plural object, but it still carries `{count}`: returning it raw left a
    // literal `{count}` on screen. `logs.matches` is such a message (English never inflects it).
    expect(tc('logs.matches', 2)).toBe('2 matches')
    expect(tc('servers.total', 5)).toBe('5 servers')
  })

  it('interpolates a second placeholder through tc()', () => {
    // The library's own `tc()` forwards only `{count}` to the plural rule, so `{total}` in
    // `logs.linesOf` used to render literally. This is the assertion that catches that.
    expect(tc('logs.linesOf', 3, { total: 10 })).toBe('3 of 10 lines')
  })

  it('resolves without throwing when its catalog cannot load', async () => {
    // The unit half of the same rule as `i18n-failure.test.ts`: `initLocale` is awaited before
    // mount, so it must not reject. A stored code with no catalog file exercises the miss path.
    const { initLocale } = await import('@/i18n')
    localStorage.setItem('hh.locale', 'vi')
    await expect(initLocale()).resolves.toBeUndefined()
    // Whatever it settled on, it is a language the UI can render.
    expect(['en', 'vi']).toContain(currentLocale())
    __resetLocaleForTests()
  })

  it('renders every locale without leaving a raw placeholder', async () => {
    // A placeholder that no longer matches its message shows up as literal `{days}` on screen, and
    // nothing else catches it: the catalog-shape test checks keys and categories, not interpolation
    // in the reader's language. This sweeps all nine.
    for (const locale of LOCALES.map(entry => entry.code)) {
      await setLocale(locale)
      for (const text of [
        t('login.sessionNote', { duration: '7d' }),
        t('theme.label', { theme: 'x' }),
        tc('servers.total', 3),
        tc('palette.results', 4),
        tc('logs.lines', 2),
      ])
        expect(text, `${locale} left a raw placeholder in ${JSON.stringify(text)}`).not.toMatch(/\{\w+\}/)
    }
  })

  it('uses CLDR plural categories for Russian', async () => {
    await setLocale('ru')
    // `servers.total` is authored as { one, few, many, other } — see plural.ts for why.
    const forms = [1, 2, 5, 21].map(n => `${n}=${tc('servers.total', n)}`)
    // `21` is CLDR `one`, so a naive index-by-count selector would give it the `many` form.
    expect(forms).toEqual(['1=1 сервер', '2=2 сервера', '5=5 серверов', '21=21 сервер'])
  })
})
