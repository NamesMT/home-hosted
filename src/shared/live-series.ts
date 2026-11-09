import type { ServerView } from './contracts'
import { liveReadings } from './server-readings'

/**
 * Client-side telemetry history.
 *
 * The panel only ever sends a *current* reading, so a chart's series is built in the UI: one ring
 * per server, fed from `state` and `server` frames and capped so a page left open for a week does
 * not grow. A point is `null` when nothing was measured — a stopped entry has no reading, and the
 * chart must break there rather than draw a vertex on the floor.
 */
export interface ServerSeries {
  ts: number[]
  cpu: (number | null)[]
  rss: (number | null)[]
  probe: (number | null)[]
  /** Last `resources.sampledAt` folded in, so 1 Hz state frames do not double up. */
  lastSampledAt: number
}

/** The panel samples the process tree every 5 s. */
export const MIN_SAMPLE_GAP_MS = 4000

export function createSeries(): ServerSeries {
  return { ts: [], cpu: [], rss: [], probe: [], lastSampledAt: -1 }
}

function trim(series: ServerSeries, capacity: number): void {
  const overflow = series.ts.length - capacity
  if (overflow <= 0)
    return
  series.ts.splice(0, overflow)
  series.cpu.splice(0, overflow)
  series.rss.splice(0, overflow)
  series.probe.splice(0, overflow)
}

export function recordSample(series: ServerSeries, server: ServerView, now: number, capacity: number): void {
  const sampledAt = server.resources?.sampledAt ?? 0
  const lastTs = series.ts[series.ts.length - 1] ?? 0
  const fresh = sampledAt !== series.lastSampledAt || now - lastTs >= MIN_SAMPLE_GAP_MS
  // The readings of a process that is not running are absent, not stale: a newer UI can meet an
  // older panel that kept them across a stop, and a chart is where a stale number looks most live.
  const live = liveReadings(server)

  if (!fresh) {
    // A newer probe reading on an unchanged sample still belongs on the tip.
    if (series.probe.length > 0)
      series.probe[series.probe.length - 1] = live.responseMs
    return
  }

  series.lastSampledAt = sampledAt
  series.ts.push(now)
  series.cpu.push(live.cpuPercent)
  series.rss.push(live.rssBytes)
  series.probe.push(live.responseMs)
  trim(series, capacity)
}
