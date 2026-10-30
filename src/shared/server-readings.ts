import type { ServerStatus } from './contracts'

/**
 * The measurements that belong to a running process, and to nothing else.
 *
 * `responseMs` and `resources` are one run's numbers: the last health probe's latency, and the
 * last CPU/RSS sample of that process tree. A viewer is told to read them as *now*, so an entry
 * that is not running has no reading — not a stale one.
 *
 * The panel clears them when a process ends, but a **newer UI is served against an older panel**
 * (the documented upgrade rule), and a panel before this release kept them across a stop of an
 * adopted successor. The verdict is on the wire beside the number, so the UI gates on that rather
 * than trusting the fields' presence — the same rule the unhealthy duration follows.
 *
 * The input is **structural** rather than `ServerView`: `noc-console` builds its rows from a
 * locally-decoded frame whose `config` is looser than the contract's, and demanding the full type
 * would push a cast into every call site.
 *
 * `portState` is deliberately not here: whether the *port* is occupied outlives the process that
 * used it (a stop leaves the occupancy probe meaningful), which is why the panel keeps taking it
 * while stopped.
 */
export interface LiveReadings {
  /** The last probe's latency in milliseconds, or null when nothing is running. */
  responseMs: number | null
  cpuPercent: number | null
  rssBytes: number | null
  processes: number | null
}

/** What the predicate needs: the verdict, plus the two readings whose lifetime it decides. */
export interface ReadingSource {
  status: ServerStatus
  responseMs?: number | null
  resources?: { cpuPercent?: number | null, rssBytes?: number | null, processes?: number | null } | null
}

const NOTHING_RUNNING: LiveReadings = { responseMs: null, cpuPercent: null, rssBytes: null, processes: null }

/** The live readings of one entry, absent rather than stale once its process is gone. */
export function liveReadings(server: ReadingSource): LiveReadings {
  if (server.status !== 'running')
    return NOTHING_RUNNING
  return {
    responseMs: server.responseMs ?? null,
    cpuPercent: server.resources?.cpuPercent ?? null,
    rssBytes: server.resources?.rssBytes ?? null,
    processes: server.resources?.processes ?? null,
  }
}

/**
 * The same reading summed across several entries — a workspace's own total.
 *
 * An aggregate is a reading of the *set*, so it inherits the set's absence: if one entry has no
 * sample the total is `null`, never the other entries' sum. `OverviewView` summed a workspace's CPU
 * with `?? 0` and printed `0.0% cpu now`, so a workspace whose only server had just started — the
 * first sampling window has no window to measure yet — claimed a measured `0.0%`. That is the
 * fabricated idle process the predicate above exists to prevent, in the one number that summarises
 * every entry at once, and it was the same shape for process memory.
 *
 * An empty list is a genuine `0`: nothing is running, and the surface beside it says so. A member
 * that honestly measured `0` also survives, because `0` is a number and only a missing one is
 * absent.
 */
export function sumReadings(servers: ReadingSource[], field: keyof LiveReadings): number | null {
  let total = 0
  for (const server of servers) {
    const value = liveReadings(server)[field]
    if (typeof value !== 'number')
      return null
    total += value
  }
  return total
}
