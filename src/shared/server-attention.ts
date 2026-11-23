import type { HealthState, ServerStatus } from './contracts'

/**
 * Whether one entry is a problem someone has to look at.
 *
 * Every surface that answers "is anything wrong" asks this — `/healthz` (which an external monitor
 * polls) and the three "needs attention" counts and filters the UIs draw. Written out at **seven**
 * call sites as a hand-picked disjunction, they had already disagreed in both directions: `/healthz`
 * answered `200 ok` with a `conflict` entry (its filter named neither `conflict` nor the panel's
 * own give-up), and the UIs counted a `stoppedByPanel` entry as "stopped", the status this predicate
 * deliberately treats as fine. So the list is read from the **status enum**, not from whichever
 * statuses a given surface happened to think of.
 *
 * A deliberate stop is not here: stopping sets `stopped`, never `crashed` or `conflict`.
 * `stoppedByPanel` is the exception, because the panel stopping an entry that cannot serve is a
 * broken service, not an operator's decision.
 */
export interface AttentionSource {
  status: ServerStatus
  health?: HealthState
  /** Optional so a newer UI reading an older panel's frame still parses it. */
  stoppedByPanel?: boolean
}

export function needsAttention(server: AttentionSource): boolean {
  // `crashed`: it died and stayed dead. `conflict`: it cannot start — its port is held, or a stop
  // could not end it. Both are the entry being down for a reason nobody chose.
  if (server.status === 'crashed' || server.status === 'conflict')
    return true
  // The panel gave up on it: `stopped`, but not because someone asked.
  if (server.stoppedByPanel === true)
    return true
  // Up and failing its own check. `status === 'running'` is load-bearing: `health` keeps its last
  // value through a stop, so a stopped entry would otherwise hold the panel degraded for ever.
  return server.status === 'running' && server.health === 'unhealthy'
}
