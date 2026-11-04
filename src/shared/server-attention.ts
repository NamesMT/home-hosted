import type { HealthState, ServerStatus } from './contracts'

/**
 * Whether one entry is a problem someone has to look at.
 *
 * Every surface that answers "is anything wrong" asks this question — the panel's own `/healthz`,
 * which an external monitor polls, and the three "needs attention" counts and filters the UIs draw
 * — and it was written out at **seven** call sites as a hand-picked disjunction. They had already
 * disagreed, in both directions, and each disagreement was invisible from the surface that got it
 * right:
 *
 *  - **`/healthz` said `ok` with a `conflict` entry.** Its filter named `crashed`, `stoppedByPanel`
 *    and a running-unhealthy entry, but not `conflict` — the status that means "this entry cannot
 *    start because its port is held". Measured on a panel whose only entry was blocked:
 *    `GET /healthz` → `200 {"status":"ok"}` while `GET /_hh/usage` and the card both read
 *    `web conflict`. A monitor watching that endpoint reported a healthy home with a server down.
 *
 *  - **The UIs said nothing about an entry the panel itself gave up on.** They read `health` and
 *    `status` but never `stoppedByPanel`, so an entry stopped after its health budget was spent
 *    counted as "stopped", which is the status the same predicate deliberately treats as fine. The
 *    card kept its reason on `lastError` and `/healthz` answered 503, so the one page a person opens
 *    to find out what broke was the one place it was not counted.
 *
 * Both are the same defect: a question with several right answers, decided once per call site. The
 * list is read from the **status enum**, not from whichever statuses a given surface happened to
 * think of, and `stoppedByPanel` is part of it because `stopped` cannot say which stop it was.
 *
 * A deliberate stop is not here, and that is the distinction the statuses exist to make: stopping
 * sets `stopped`, never `crashed` or `conflict`. `stoppedByPanel` is the exception, because the
 * panel stopping an entry that cannot serve is a broken service, not an operator's decision.
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
