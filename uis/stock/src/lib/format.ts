import type { DurationUnit, DurationWords } from '@shared/ui-format'
import { formatAgo as sharedFormatAgo, formatDuration as sharedFormatDuration, relativeFrom as sharedRelativeFrom } from '@shared/ui-format'
import { currentLocale, t } from '@/i18n'
import { localeMeta } from '@/i18n/locales'

// `formatRatio` and `formatClock` carry no words, so they are the two the UIs can share outright.
export { formatClock, formatRatio } from '@shared/ui-format'

/**
 * The ISO tag for the language the UI is showing.
 *
 * `toLocaleString(undefined, …)` follows the *browser's* locale, which is not the language the
 * panel is in — picking Japanese would leave every timestamp in English month names. Falls back
 * to the browser when the active code somehow has no mapping.
 */
export function activeLocaleTag(): string | undefined {
  return localeMeta(currentLocale())?.iso
}

/** One formatter per language; constructing them is not free and these run on every frame. */
const relativeCache = new Map<string, Intl.RelativeTimeFormat>()
const unitCache = new Map<string, Intl.NumberFormat>()

/**
 * The stock UI's duration words, in the reader's language.
 *
 * `Intl` does the work rather than a catalog: it already knows each language's word order
 * (`vor 12 Sek.` / `12 秒前` / `через 2 ч`), abbreviations and plurals, so there is nothing to
 * translate by hand and nothing to keep in step as languages are added.
 *
 * English is the one exception, deliberately: `narrow` gives it the original `12s ago` while every
 * other language reads better at `short` (`short` would make English `12 sec. ago`, changing text
 * nobody asked to change; `narrow` gives Russian and French a bare `-12 с` with no direction word).
 */
const UNIT_STYLE: Record<DurationUnit, string> = { s: 's', m: 'm', h: 'h', d: 'd' }

function isEnglish(): boolean {
  return currentLocale() === 'en'
}

function relativeFormatter(): Intl.RelativeTimeFormat {
  const locale = activeLocaleTag()
  const style: Intl.RelativeTimeFormatStyle = isEnglish() ? 'narrow' : 'short'
  const key = `${locale ?? ''}:${style}`
  let formatter = relativeCache.get(key)
  if (formatter === undefined) {
    // `always` keeps a span a span, so `1m ago` never becomes `yesterday` (which is not an age).
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style })
    relativeCache.set(key, formatter)
  }
  return formatter
}

/**
 * A bare amount and unit, e.g. `1h` / `1時間` / `1 ч`.
 *
 * `Intl.NumberFormat`'s unit style is the right tool for the two-unit span: `RelativeTimeFormat`
 * always states a direction, which reads wrong twice in `1h ago 30m ago`.
 */
function unitText(value: number, name: DurationUnit): string {
  // English keeps the `1h 30m` the formatters produced before this was localizable.
  if (isEnglish())
    return `${value}${UNIT_STYLE[name]}`
  const map: Record<DurationUnit, string> = { s: 'second', m: 'minute', h: 'hour', d: 'day' }
  const locale = activeLocaleTag()
  const key = `${locale ?? ''}:${name}`
  let formatter = unitCache.get(key)
  if (formatter === undefined) {
    // `short`, not `narrow`: narrow falls back to Latin (`1h 30m`) in Japanese, where the panel reads
    // `1 時間 30 分`. English is handled above and never reaches this.
    formatter = new Intl.NumberFormat(locale, { style: 'unit', unit: map[name], unitDisplay: 'short' })
    unitCache.set(key, formatter)
  }
  return formatter.format(value)
}

/**
 * `Intl`'s phrasal form for a moment, in the direction `sign` says.
 *
 * The sign is the direction and the magnitude the amount, which is what keeps "in 4s" and "12s ago"
 * from being the same call — passing a negative count for both rendered a countdown as `4s ago`.
 */
function momentText(value: number, name: DurationUnit, sign: 1 | -1): string {
  const map: Record<DurationUnit, Intl.RelativeTimeFormatUnit> = { s: 'second', m: 'minute', h: 'hour', d: 'day' }
  return relativeFormatter().format(sign * value, map[name])
}

const words: DurationWords = {
  span: (value, name, tail) => (tail === null ? unitText(value, name) : `${unitText(value, name)} ${unitText(tail.value, tail.unit)}`),
  now: () => t('common.now'),
  ahead: (value, name) => momentText(value, name, 1),
  ago: (value, name) => momentText(value, name, -1),
  never: () => t('common.never'),
}

/** A span as its two largest units, in the reader's language. Unknown reads as an em-dash. */
export function formatDuration(ms: number): string {
  return sharedFormatDuration(ms, words)
}

/** A forward countdown, e.g. `in 4s` / `4 秒後`. */
export function relativeFrom(ts: number, now: number): string {
  return sharedRelativeFrom(ts, now, words)
}

/** How long ago, coarsely, in the reader's language. `null` is "never". */
export function formatAgo(ts: number | null, now: number): string {
  return sharedFormatAgo(ts, now, words)
}

/** `HH:MM:SS.mmm` — the log viewer needs the sub-second part to be useful. */
export function formatClockMs(ts: number): string {
  const date = new Date(ts)
  const base = date.toLocaleTimeString(activeLocaleTag(), { hour12: false })
  return `${base}.${String(date.getMilliseconds()).padStart(3, '0')}`
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(activeLocaleTag(), {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(activeLocaleTag(), { year: 'numeric', month: 'short', day: '2-digit' })
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes))
    return '—'
  if (bytes < 1024)
    return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(0)} KiB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

/** Compact form for gauges and stat tiles: `1.4 GB`, `812 MB`. */
export function formatBytesShort(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes))
    return '—'
  const abs = Math.abs(bytes)
  if (abs < 1000)
    return `${bytes} B`
  if (abs < 1000 * 1000)
    return `${(bytes / 1000).toFixed(0)} kB`
  if (abs < 1000 * 1000 * 1000)
    return `${(bytes / 1000 / 1000).toFixed(1)} MB`
  return `${(bytes / 1000 / 1000 / 1000).toFixed(2)} GB`
}

/** `12.4 MB/s` style rates, used for log volume and disk throughput. */
export function formatCpuPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value))
    return '—'
  if (value >= 100)
    return `${Math.round(value)}%`
  return `${value.toFixed(1)}%`
}

/** One value in a change review: a missing snapshot entry reads as "unset". */
export function formatChangeValue(value: unknown): string {
  if (value === undefined)
    return t('common.unset')
  return typeof value === 'string' ? value : JSON.stringify(value)
}
