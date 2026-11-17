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
 * A **date** is ISO, in the host's timezone, in every language — it is not localised at all.
 *
 * It used to be localised: `toLocaleString(activeLocaleTag(), …)` rendered `Nov 17, 2026, 10:11:43`
 * in English and `2026年11月17日 10:11:43` in Japanese, while noc-console rendered
 * `11/17/2026, 10:11:43` and its accounts table `11/17/26, 10:11 AM` — three spellings of one moment,
 * and none of them the same characters a log line or the CLI printed. For a control panel that is
 * the wrong trade: `03/04/2026` is a different day in two of the nine languages this UI ships, and a
 * date a person compares against a log needs to sort and match as a string.
 *
 * So this test now asserts the **opposite** of what it used to: the output must be identical in
 * every language, sortable, and unambiguous.
 */
describe('formatDateTime', () => {
  afterEach(() => __resetLocaleForTests())

  it('renders an ISO timestamp that no language changes', async () => {
    // 04:48:03 UTC; the host offset is applied, so build the expectation from the same Date rather
    // than hardcoding a zone the test machine may not be in.
    const stamp = Date.UTC(2026, 10, 17, 4, 48, 3)
    const date = new Date(stamp)
    const pad = (value: number): string => String(value).padStart(2, '0')
    const expected = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`

    expect(formatDateTime(stamp)).toBe(expected)
    // Sortable as a string, which is the whole point of ISO.
    expect(formatDateTime(stamp)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

    for (const locale of ['ja', 'zh-CN', 'ko', 'ru', 'de', 'fr', 'es', 'vi']) {
      await setLocale(locale)
      expect(formatDateTime(stamp), `${locale} must not reformat a date`).toBe(expected)
    }
  })

  it('never renders a month name or a slashed date', async () => {
    const stamp = Date.UTC(2026, 10, 17, 4, 48, 3)
    for (const locale of ['en', 'ja', 'zh-CN', 'ru']) {
      await setLocale(locale)
      const text = formatDateTime(stamp)
      expect(text, `${locale} rendered a month name`).not.toMatch(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|月|янв/i)
      expect(text, `${locale} rendered a slashed date`).not.toMatch(/\d\/\d/)
    }
  })

  it('renders an unparseable timestamp as a dash, never Invalid Date', () => {
    expect(formatDateTime(Number.NaN)).toBe('—')
  })
})

/**
 * No surface builds its own date formatter, in **either** UI.
 *
 * The helper is only half the fix: the accounts tables each carried their own formatter, so fixing
 * `formatDateTime` would not have reached them — that is exactly how an English date survived a
 * Japanese panel, and how three different spellings of one moment ended up on two pages of the same
 * product. A scan is what makes the next one use the shared path.
 *
 * The pattern is deliberately broad (`toLocale*` and `Intl.DateTimeFormat`), because a date that is
 * re-formatted anywhere but `src/lib/format.ts` is the defect: it either follows the browser instead of
 * the panel or spells the date a second way. `format.ts` itself is exempt — it is the one place that
 * converts a timestamp into characters — and a `toLocale*` call on a **number** is not a date
 * (`formatRatio` and friends), so numbers are excluded by requiring the call to sit on a
 * date-ish expression or to carry date options.
 */
describe('a date has one spelling, and only one place builds it', () => {
  const DATE_SHAPED = /new Intl\.DateTimeFormat\(|(?:new Date\([^)]*\)|ts|stamp|\.(?:createdAt|uploadedAt|lastUsedAt|startedAt|endedAt|at))\.toLocale(?:String|DateString|TimeString)\(/

  function offendersIn(ui: string): string[] {
    const srcDir = path.resolve(process.cwd(), 'uis', ui, 'src')
    const offenders: string[] = []
    for (const entry of fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:ts|vue)$/.test(entry.name))
        continue
      const file = path.join(entry.parentPath, entry.name)
      // The UI's own format module is where a timestamp becomes characters; it is the one exemption.
      if (path.basename(file) === 'format.ts' && path.basename(entry.parentPath) === 'lib')
        continue
      const source = fs.readFileSync(file, 'utf8')
      for (const match of source.matchAll(new RegExp(DATE_SHAPED.source, 'g'))) {
        const line = source.slice(0, match.index).split('\n').length
        offenders.push(`${ui}/${path.relative(srcDir, file)}:${line}`)
      }
    }
    return offenders
  }

  it('has no date formatter outside lib/format.ts, in either UI', () => {
    expect([...offendersIn('stock'), ...offendersIn('noc-console')]).toEqual([])
  })

  it('catches the shapes it claims to, so the scan is not vacuous', () => {
    const probe = [
      'const a = new Intl.DateTimeFormat(undefined, { dateStyle: "short" }).format(ms)',
      'const b = new Date(ts).toLocaleString(undefined, { hour12: false })',
      'const c = ts.toLocaleDateString()',
      'const d = row.createdAt.toLocaleString()',
    ]
    for (const line of probe)
      expect(line.match(DATE_SHAPED), `the scan must see: ${line}`).not.toBeNull()
    // A number formatter is not a date and must stay allowed.
    expect('ratio.toLocaleString(undefined, { style: "percent" })'.match(DATE_SHAPED)).toBeNull()
  })
})
