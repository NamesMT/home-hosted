/**
 * Formatting both UIs share, so a fix lands once instead of in two copies.
 *
 * Only the genuinely identical functions live here: `formatBytes`, `formatBytesShort` and
 * `formatDateTime` differ between the products on purpose (signatures, thresholds, locale options)
 * and stay where they are.
 *
 * The relative-time functions take **words**. The rule (which unit, which threshold, the
 * backwards-clock clamp) belongs here; the words do not, because `src/shared/` may not import a
 * UI's i18n. A caller that ships one language passes nothing and gets the English it always got.
 */

/** A 0–1 ratio as a percentage. Unknown reads as an em-dash, never the literal `NaN%`. */
export function formatRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value))
    return '—'
  return `${(value * 100).toFixed(value >= 0.999 ? 0 : 1)}%`
}

/** Wall-clock time, 24-hour, in the host locale. */
export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false })
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

const ENGLISH_DURATION_WORDS: DurationWords = {
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

/** Milliseconds in a second — the one conversion a duration field needs. */
const MS_PER_SECOND = 1000

/**
 * A millisecond setting, shown to a person in **seconds**.
 *
 * The config stores `ms` because that is what a timer is; nothing about it is worth retyping, and
 * changing it would be a migration for no gain. But a person never thinks "1200000" — every field
 * whose floor is a second or more (`sessionTtlMs` 60s, `lockoutMs` 1s, the vitals `intervalMs` 5s,
 * the notification `cooldownMs`, and the DDNS check interval) is edited in seconds and converted
 * here, once, rather than at eight call sites.
 *
 * Rounding is deliberate: a value stored as `1500` reads `2s`, and only a *change* writes, so
 * simply visiting a page cannot rewrite a config that was fine.
 */
export function msToSeconds(ms: number): number {
  return Math.round(ms / MS_PER_SECOND)
}

/** The inverse: whole seconds back to the milliseconds the config stores. */
export function secondsToMs(seconds: number): number {
  return Math.round(seconds) * MS_PER_SECOND
}

/**
 * Whether a field is shown in seconds.
 *
 * Decided by the schema's floor, not per call site: below a second (`health.timeoutMs` starts at
 * 100 ms, `intervalMs` at 500) a seconds box would round away the only values the field accepts, so
 * those stay in `ms`. A field whose floor is 1000 or more has no meaningful sub-second value, which
 * is what makes the conversion safe to apply.
 */
export function shownInSeconds(minMs: number): boolean {
  return minMs >= MS_PER_SECOND
}
