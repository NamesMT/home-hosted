export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false })
}

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

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0)
    return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60)
    return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function relativeFrom(ts: number, now: number): string {
  const delta = Math.max(0, ts - now)
  if (delta < 1000)
    return 'now'
  if (delta < 60000)
    return `in ${Math.ceil(delta / 1000)}s`
  return `in ${Math.ceil(delta / 60000)}m`
}

export function formatRatio(value: number | null): string {
  if (value === null)
    return '—'
  return `${(value * 100).toFixed(value >= 0.999 ? 0 : 1)}%`
}

export function formatPercent(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value))
    return '—'
  return `${value.toFixed(digits)}%`
}

export function formatAgo(ts: number | null, now: number): string {
  if (ts === null)
    return 'never'
  const delta = Math.max(0, now - ts)
  if (delta < 60_000)
    return `${Math.floor(delta / 1000)}s ago`
  if (delta < 3_600_000)
    return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000)
    return `${Math.floor(delta / 3_600_000)}h ago`
  return `${Math.floor(delta / 86_400_000)}d ago`
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
export function formatBytesRate(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes))
    return '—'
  return `${formatBytesShort(bytes)}/s`
}

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
