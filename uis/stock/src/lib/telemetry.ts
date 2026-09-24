import type { ServerView } from '@shared/contracts'
import { reactive } from 'vue'

/**
 * Client-side telemetry history.
 *
 * The control plane only ever sends a *current* resource reading, so the chart
 * series are built here: one ring buffer per server, fed from SSE `server`
 * frames and capped so a panel left open for a week does not grow.
 */

export const SERIES_CAPACITY = 120

export interface ServerSeries {
  ts: number[]
  cpu: (number | null)[]
  rss: (number | null)[]
  probe: (number | null)[]
  /** Last `resources.sampledAt` folded in, so 1 Hz state frames do not double up. */
  lastSampledAt: number
}

/** The control plane samples the process tree every 5 s. */
const MIN_GAP_MS = 4000

export function createSeries(): ServerSeries {
  // Reactive so charts re-render as samples are folded in, without a tick counter.
  return reactive({ ts: [], cpu: [], rss: [], probe: [], lastSampledAt: -1 })
}

function trim(series: ServerSeries): void {
  const overflow = series.ts.length - SERIES_CAPACITY
  if (overflow <= 0)
    return
  series.ts.splice(0, overflow)
  series.cpu.splice(0, overflow)
  series.rss.splice(0, overflow)
  series.probe.splice(0, overflow)
}

export function recordSample(series: ServerSeries, server: ServerView, now: number): void {
  const sampledAt = server.resources?.sampledAt ?? 0
  const lastTs = series.ts[series.ts.length - 1] ?? 0
  const fresh = sampledAt !== series.lastSampledAt || now - lastTs >= MIN_GAP_MS

  if (!fresh) {
    // A newer probe reading on an unchanged sample still belongs on the tip.
    if (series.probe.length > 0)
      series.probe[series.probe.length - 1] = server.responseMs
    return
  }

  series.lastSampledAt = sampledAt
  series.ts.push(now)
  const live = server.status === 'running'
  series.cpu.push(live ? server.resources?.cpuPercent ?? null : null)
  series.rss.push(live ? server.resources?.rssBytes ?? null : null)
  series.probe.push(server.responseMs)
  trim(series)
}

export function seriesTotal(values: (number | null)[]): number {
  let total = 0
  for (const value of values) {
    if (value !== null)
      total += value
  }
  return total
}

export function seriesMax(values: (number | null)[]): number {
  let max = 0
  for (const value of values) {
    if (value !== null && value > max)
      max = value
  }
  return max
}

export function seriesLast(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i]
    if (value !== undefined && value !== null)
      return value
  }
  return null
}
