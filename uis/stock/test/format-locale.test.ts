// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { __resetLocaleForTests, setLocale } from '@/i18n'
import { formatAgo, formatDuration, relativeFrom } from '@/lib/format'

/**
 * Durations must follow the UI's language.
 *
 * These formatters produced English inline ("12s ago", "1h 30m"), which a translated panel showed
 * verbatim: the Japanese UI read 「起動しました 12s ago」 — the one English left on an otherwise Japanese
 * screen, and exactly the kind of leak no catalog test can see, because the string was never in a
 * catalog.
 *
 * English is pinned to the exact strings it produced before, since a language switch must not change
 * the language nobody switched away from.
 */
describe('formatDuration', () => {
  afterEach(() => __resetLocaleForTests())

  it('keeps the original English wording', () => {
    // Byte-identical to what these functions returned before they were localizable.
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(1_000)).toBe('1s')
    expect(formatDuration(90_000)).toBe('1m 30s')
    expect(formatDuration(3_600_000)).toBe('1h 0m')
    expect(formatDuration(90_000_000)).toBe('1d 1h')
    expect(formatDuration(Number.NaN)).toBe('—')
  })

  it('renders a span in the reader’s language', async () => {
    for (const [locale, expected] of [['ja', '1 分 30 秒'], ['ru', '1 мин 30 с'], ['zh-CN', '1分钟 30秒'], ['vi', '1 phút 30 giây']] as const) {
      await setLocale(locale)
      expect(formatDuration(90_000), locale).toBe(expected)
    }
  })
})

describe('formatAgo', () => {
  afterEach(() => __resetLocaleForTests())

  it('keeps the original English wording', () => {
    expect(formatAgo(null, 0)).toBe('never')
    expect(formatAgo(2_000, 1_000), 'a future timestamp clamps').toBe('0s ago')
    expect(formatAgo(1_000, 61_000)).toBe('1m ago')
    expect(formatAgo(1_000, 1_000 + 3_600_000)).toBe('1h ago')
    // `numeric: 'always'` matters: 'auto' renders `1d` as "yesterday", which is a calendar day rather
    // than an age, and says nothing about how long something has been running.
    expect(formatAgo(1_000, 1_000 + 86_400_000)).toBe('1d ago')
  })

  it('renders "ago" in the reader’s language', async () => {
    for (const locale of ['ja', 'ru', 'de', 'zh-CN', 'ko', 'es', 'fr', 'vi']) {
      await setLocale(locale)
      const text = formatAgo(1_000, 13_000)
      // The English word must be gone, and the number must survive.
      expect(text, `${locale} still says "ago"`).not.toMatch(/\bago\b/i)
      expect(text, `${locale} lost the count`).toContain('12')
    }
  })
})

describe('relativeFrom', () => {
  afterEach(() => __resetLocaleForTests())

  it('keeps the original English wording', () => {
    expect(relativeFrom(1_000, 1_000)).toBe('now')
    expect(relativeFrom(500, 1_000), 'a past moment is never negative').toBe('now')
    expect(relativeFrom(5_000, 1_000)).toBe('in 4s')
    expect(relativeFrom(121_000, 1_000)).toBe('in 2m')
  })

  it('renders a countdown in the reader’s language, and never as a past moment', async () => {
    // German's word for "in" is also `in`, so this asserts the direction rather than the spelling:
    // a forward moment must not read as "ago" in any language, and the count must survive.
    for (const locale of ['ja', 'ru', 'de', 'zh-CN', 'ko', 'es', 'fr', 'vi']) {
      await setLocale(locale)
      const text = relativeFrom(5_000, 1_000)
      // The count survives, and the phrasing is a forward one — the bug this guards rendered a
      // countdown as `4s ago`. Compared against `Intl` rather than a literal: CLDR puts a
      // non-breaking space before a Russian unit, and hardcoding one language's spacing here would
      // assert a detail this code does not own.
      expect(text, `${locale} lost the count`).toContain('4')
      expect(text, `${locale} reads as the past`).not.toMatch(/ago|前|назад|hace/i)
      expect(text, `${locale} is not the formatter's forward phrasing`).toBe(new Intl.RelativeTimeFormat(
        { 'ja': 'ja-JP', 'ru': 'ru-RU', 'de': 'de-DE', 'zh-CN': 'zh-CN', 'ko': 'ko-KR', 'es': 'es-ES', 'fr': 'fr-FR', 'vi': 'vi-VN' }[locale],
        { numeric: 'always', style: 'short' },
      ).format(4, 'second'))
    }
  })
})
