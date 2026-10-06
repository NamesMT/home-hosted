/**
 * Date and duration formatting shared by both UIs.
 *
 * These four were byte-identical copies in `uis/stock/src/lib/format.ts` and
 * `uis/noc-console/src/lib/format.ts` — 911 duplicated characters. The cost is not the bytes: fixing
 * `formatRatio`'s missing guard in one UI left the other still rendering `NaN%`, which is exactly the
 * "carry the fix into the other UI" commit that `proxy-form.ts` was created to stop.
 *
 * Only the functions that are genuinely the same live here. `formatBytes`, `formatRatio` and
 * `formatClockMs` differ between the two products on purpose (unit thresholds, decimal places) and
 * stay where they are.
 */

/** Wall-clock time, 24-hour, in the viewer's locale. */
export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false })
}

/** A span as its two largest units: `1h 30m`, `2d 3h`. Unknown or negative reads as an em-dash. */
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

/** A **forward** countdown to an expiry: a moment already past clamps to `now`, never negative. */
export function relativeFrom(ts: number, now: number): string {
  const delta = Math.max(0, ts - now)
  if (delta < 1000)
    return 'now'
  if (delta < 60000)
    return `in ${Math.ceil(delta / 1000)}s`
  return `in ${Math.ceil(delta / 60000)}m`
}

/** How long ago, coarsely. `null` is "never", and a backwards clock clamps to `0s ago`. */
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
