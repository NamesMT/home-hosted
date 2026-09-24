export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false })
}

export function formatStamp(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { hour12: false })
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

/** Compact htop-style uptime: `3d04h`, `2h11m`, `07m42s`, `42s`. */
export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0)
    return '—'
  const total = Math.floor(ms / 1000)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (days > 0)
    return `${days}d${String(hours).padStart(2, '0')}h`
  if (hours > 0)
    return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0)
    return `${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
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

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes))
    return '—'
  if (bytes < 1024)
    return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(0)} KiB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

export function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value))
    return '—'
  if (value < 1000)
    return `${value.toFixed(value < 10 ? 1 : 0)}ms`
  return `${(value / 1000).toFixed(2)}s`
}

/** `90000` -> `1m 30s`; used for config durations where a raw ms reads badly. */
export function formatMsHint(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0)
    return 'off'
  return formatDuration(ms)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function loadPerCpu(loadAvg: number[], cpus: number): number {
  return (loadAvg[0] ?? 0) / Math.max(1, cpus)
}

/** SVG polyline points for a sparkline in a `width` x `height` box. */
export function sparkPoints(values: number[], width: number, height: number, max?: number): string {
  if (values.length === 0)
    return ''
  const top = max !== undefined && max > 0 ? max : Math.max(...values)
  const scale = top > 0 ? top : 1
  const step = values.length > 1 ? width / (values.length - 1) : 0
  return values
    .map((value, index) => {
      const x = values.length > 1 ? index * step : width
      const y = height - clamp(value / scale, 0, 1) * (height - 2) - 1
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}

export const shortByteUnits = ['B', 'K', 'M', 'G', 'T'] as const

/** Bare number for a dense cell, with the unit in a separate column. */
export function briefBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes))
    return '—'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < shortByteUnits.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)}${shortByteUnits[unit]}`
}

export function pct(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value))
    return '—'
  return `${value.toFixed(digits)}%`
}
