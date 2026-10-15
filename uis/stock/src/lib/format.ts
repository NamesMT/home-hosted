import type { DurationUnit, DurationWords } from '@shared/ui-format'
import { formatAgo as sharedFormatAgo, formatDuration as sharedFormatDuration, relativeFrom as sharedRelativeFrom } from '@shared/ui-format'
import { currentLocale, t } from '@/i18n'
import { localeMeta } from '@/i18n/locales'

// `formatRatio` carries no words, so it is the one the UIs can share outright.
export { formatRatio } from '@shared/ui-format'

/**
 * The ISO tag for the language the UI shows.
 *
 * `toLocaleString(undefined, …)` would follow the *browser*, which is not the panel's language —
 * picking Japanese would leave every timestamp in English month names.
 */
export function activeLocaleTag(): string | undefined {
  return localeMeta(currentLocale())?.iso
}

/** One formatter per language; constructing them is not free and these run on every frame. */
const relativeCache = new Map<string, Intl.RelativeTimeFormat>()
const unitCache = new Map<string, Intl.NumberFormat>()

/** English's own suffixes, so `unitText` needs no `Intl` call for the common language. */
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
    // `always` keeps a span a span, so `1m ago` never becomes `yesterday`.
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style })
    relativeCache.set(key, formatter)
  }
  return formatter
}

/**
 * A bare amount and unit, e.g. `1h` / `1時間` / `1 ч`. `RelativeTimeFormat` is wrong here: it always
 * states a direction, which reads twice in `1h ago 30m ago`.
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
    // `short`, not `narrow`: narrow falls back to Latin in Japanese (`1h 30m`, not `1 時間 30 分`).
    formatter = new Intl.NumberFormat(locale, { style: 'unit', unit: map[name], unitDisplay: 'short' })
    unitCache.set(key, formatter)
  }
  return formatter.format(value)
}

/**
 * `Intl`'s phrasal form for a moment. The sign is the direction, the magnitude the amount — passing a
 * negative count for both would render a countdown as `4s ago`.
 */
function momentText(value: number, name: DurationUnit, sign: 1 | -1): string {
  const map: Record<DurationUnit, Intl.RelativeTimeFormatUnit> = { s: 'second', m: 'minute', h: 'hour', d: 'day' }
  return relativeFormatter().format(sign * value, map[name])
}

/**
 * The stock UI's duration words, in the reader's language.
 *
 * `Intl` does the work rather than a catalog: it knows each language's word order, abbreviations and
 * plurals, so nothing needs translating by hand as languages are added.
 *
 * English is the deliberate exception — `narrow` keeps its original `12s ago`, where `short` reads
 * `12 sec. ago`; `narrow` is wrong for the others, where Russian and French lose the direction word.
 */
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
