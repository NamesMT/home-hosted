/**
 * Formatting both UIs share.
 *
 * These were byte-identical copies in `uis/stock/src/lib/format.ts` and
 * `uis/noc-console/src/lib/format.ts` — 911 duplicated characters across four functions. The cost is
 * not the bytes: fixing `formatRatio`'s missing guard in one UI left the other still rendering `NaN%`,
 * which is exactly the "carry the fix into the other UI" commit that `proxy-form.ts` was created to
 * stop. `formatRatio` then became identical again once both had the guard, so it moved here too — the
 * guard was fixed twice before the copy was removed, which is the duplication arguing for itself.
 *
 * Only the functions that are genuinely the same live here. `formatBytes`, `formatBytesShort` and
 * `formatDateTime` differ between the two products on purpose (signatures, unit thresholds, locale
 * options) and stay where they are.
 *
 * **The relative-time functions take words.** They used to build English inline ("12s ago"), which a
 * translated UI then showed verbatim — the Japanese panel read 「起動しました 12s ago」. The *rule* (which
 * unit, which threshold, the backwards-clock clamp) is what belongs here; the *words* do not, because
 * `src/shared/` may not import a UI's i18n. A caller that ships one language passes nothing and gets
 * exactly the English it got before.
 */

/** A 0–1 ratio as a percentage. Unknown reads as an em-dash, never the literal `NaN%`. */
export function formatRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value))
    return '—'
  return `${(value * 100).toFixed(value >= 0.999 ? 0 : 1)}%`
}

/** Wall-clock time, 24-hour, in `locale` (the host locale when omitted). */
export function formatClock(ts: number, locale?: string): string {
  return new Date(ts).toLocaleTimeString(locale, { hour12: false })
}

/** The unit a span counts in. `s`/`m`/`h`/`d` keep the call sites free of a translated word. */
export type DurationUnit = 's' | 'm' | 'h' | 'd'

/**
 * The words the relative-time formatters put around a measurement.
 *
 * Each takes the raw value and unit rather than a pre-rendered fragment, so a caller can reach for
 * `Intl.RelativeTimeFormat` — which knows each language's word order, plurals and abbreviations —
 * instead of concatenating translated pieces.
 */
export interface DurationWords {
  /** A span as its two largest units: `1h 30m`. `tail` is null for a single unit. */
  span: (value: number, unit: DurationUnit, tail: { value: number, unit: DurationUnit } | null) => string
  /** The moment has arrived. */
  now: () => string
  /** A forward countdown: `in 4s`. */
  ahead: (value: number, unit: 's' | 'm') => string
  /** A moment in the past: `12s ago`. */
  ago: (value: number, unit: DurationUnit) => string
  /** No such moment ever happened. */
  never: () => string
}

export const ENGLISH_DURATION_WORDS: DurationWords = {
  span: (value, unit, tail) => (tail === null ? `${value}${unit}` : `${value}${unit} ${tail.value}${tail.unit}`),
  now: () => 'now',
  ahead: (value, unit) => `in ${value}${unit}`,
  ago: (value, unit) => `${value}${unit} ago`,
  never: () => 'never',
}

/** A span as its two largest units: `1h 30m`, `2d 3h`. Unknown or negative reads as an em-dash. */
export function formatDuration(ms: number, words: DurationWords = ENGLISH_DURATION_WORDS): string {
  if (!Number.isFinite(ms) || ms < 0)
    return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60)
    return words.span(seconds, 's', null)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return words.span(minutes, 'm', { value: seconds % 60, unit: 's' })
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return words.span(hours, 'h', { value: minutes % 60, unit: 'm' })
  return words.span(Math.floor(hours / 24), 'd', { value: hours % 24, unit: 'h' })
}

/** A **forward** countdown to an expiry: a moment already past clamps to `now`, never negative. */
export function relativeFrom(ts: number, now: number, words: DurationWords = ENGLISH_DURATION_WORDS): string {
  const delta = Math.max(0, ts - now)
  if (delta < 1000)
    return words.now()
  if (delta < 60000)
    return words.ahead(Math.ceil(delta / 1000), 's')
  return words.ahead(Math.ceil(delta / 60000), 'm')
}

/** How long ago, coarsely. `null` is "never", and a backwards clock clamps to `0s ago`. */
export function formatAgo(ts: number | null, now: number, words: DurationWords = ENGLISH_DURATION_WORDS): string {
  if (ts === null)
    return words.never()
  const delta = Math.max(0, now - ts)
  if (delta < 60_000)
    return words.ago(Math.floor(delta / 1000), 's')
  if (delta < 3_600_000)
    return words.ago(Math.floor(delta / 60_000), 'm')
  if (delta < 86_400_000)
    return words.ago(Math.floor(delta / 3_600_000), 'h')
  return words.ago(Math.floor(delta / 86_400_000), 'd')
}
