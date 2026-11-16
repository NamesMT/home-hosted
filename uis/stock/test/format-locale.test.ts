// @vitest-environment happy-dom
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { __resetLocaleForTests, setLocale } from '@/i18n'
import { formatAgo, formatDateTime, formatDuration, relativeFrom } from '@/lib/format'

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
    expect(formatDuration(3_600_000)).toBe('1h')
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

  /**
   * A countdown an hour or more out names its hours, in every language.
   *
   * The tiers above minutes were missing, so the Jobs page read `in 694m` for a run due tomorrow —
   * a number a person has to divide by 60 before it means anything. The unit word is `Intl`'s
   * (`時間`, `ч`, `Std.`), so this asserts the *unit*, not its spelling: the hour formatter's own
   * output must be what came back, and it must not still be a minute count.
   */
  it('names the hours on a long countdown, in the reader’s language', async () => {
    const tags: Record<string, string> = { 'ja': 'ja-JP', 'ru': 'ru-RU', 'de': 'de-DE', 'zh-CN': 'zh-CN', 'ko': 'ko-KR', 'es': 'es-ES', 'fr': 'fr-FR', 'vi': 'vi-VN' }
    for (const locale of Object.keys(tags)) {
      await setLocale(locale)
      // 12 hours and 23 minutes away — the shape a nightly job actually has.
      const text = relativeFrom(1_000 + 12 * 3_600_000 + 23 * 60_000, 1_000)
      const expected = new Intl.RelativeTimeFormat(tags[locale], { numeric: 'always', style: 'short' }).format(13, 'hour')
      expect(text, `${locale} did not name the hours`).toBe(expected)
      expect(text, `${locale} still counts in minutes`).not.toMatch(/\bm\b|分|мин|min/i)
    }
  })
})

/**
 * A wall-clock timestamp follows the UI's language too, and one column did not.
 *
 * The accounts table built its own `Intl.DateTimeFormat(undefined, …)`: passing `undefined` as the
 * locale follows the **browser**, which is not the panel's language. Measured in Chromium with the
 * UI set to 日本語 on `/global/settings`: the accounts row still read `Nov 16, 2026, 12:57 AM` while
 * every other timestamp on the same page read `2026年11月17日 04:48:03` — an English date in the one
 * column a person uses to check when an account last signed in. `formatDateTime` is the helper that
 * passes `activeLocaleTag()`.
 */
describe('formatDateTime', () => {
  afterEach(() => __resetLocaleForTests())

  it('renders the clock in the reader’s language, not the browser’s', async () => {
    const stamp = Date.UTC(2026, 10, 17, 4, 48, 3)
    const english = formatDateTime(stamp)
    // English keeps the spelling every other timestamp on the page uses.
    expect(english).toMatch(/Nov/)
    for (const [locale, expected] of [['ja', '2026年11月17日'], ['zh-CN', '2026年11月'], ['ko', '2026']] as const) {
      await setLocale(locale)
      const text = formatDateTime(stamp)
      expect(text, `${locale} still renders an English month`).not.toMatch(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/)
      expect(text, `${locale} lost the date`).toContain(expected)
    }
  })
})

/**
 * …and no surface builds its own `Intl.DateTimeFormat` with a `undefined` locale.
 *
 * The helper is only half the fix: the accounts table had its own formatter, so fixing the helper
 * would not have reached it. A scan is what makes the next one use the shared path — `undefined`
 * means "whatever the browser says", and that is exactly how an English date survived a Japanese
 * panel. Every timestamp in this UI goes through `formatDateTime`/`formatClock*`.
 */
describe('a date is never formatted in the browser’s locale', () => {
  it('routes every timestamp through the locale-aware helpers', () => {
    const srcDir = path.resolve(process.cwd(), 'uis/stock/src')
    const offenders: string[] = []
    for (const entry of fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:ts|vue)$/.test(entry.name))
        continue
      const file = path.join(entry.parentPath, entry.name)
      // `lib/format.ts` *is* the helper module; its own `activeLocaleTag()` call is the one allowed
      // spelling, and it never passes `undefined`.
      if (path.basename(file) === 'format.ts' && path.basename(entry.parentPath) === 'lib')
        continue
      const source = fs.readFileSync(file, 'utf8')
      for (const match of source.matchAll(/new Intl\.DateTimeFormat\(\s*undefined/g)) {
        const line = source.slice(0, match.index).split('\n').length
        offenders.push(`${path.relative(srcDir, file)}:${line}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('has no other locale-blind date construction either', () => {
    const srcDir = path.resolve(process.cwd(), 'uis/stock/src')
    const offenders: string[] = []
    for (const entry of fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:ts|vue)$/.test(entry.name))
        continue
      const file = path.join(entry.parentPath, entry.name)
      if (path.basename(file) === 'format.ts' && path.basename(entry.parentPath) === 'lib')
        continue
      const source = fs.readFileSync(file, 'utf8')
      // `toLocaleDateString`/`toLocaleString` with no locale argument does the same thing.
      for (const match of source.matchAll(/.(?:toLocaleString|toLocaleDateString|toLocaleTimeString)(s*)/g)) {
        const line = source.slice(0, match.index).split('\n').length
        offenders.push(`${path.relative(srcDir, file)}:${line}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
