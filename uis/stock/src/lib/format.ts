// The subset both UIs share; see that module for why only these four live there.
export { formatAgo, formatClock, formatDuration, formatRatio, relativeFrom } from '@shared/ui-format'

/** `HH:MM:SS.mmm` — the log viewer needs the sub-second part to be useful. */
export function formatClockMs(ts: number): string {
  const date = new Date(ts)
  const base = date.toLocaleTimeString(undefined, { hour12: false })
  return `${base}.${String(date.getMilliseconds()).padStart(3, '0')}`
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
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
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' })
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
    return 'unset'
  return typeof value === 'string' ? value : JSON.stringify(value)
}
