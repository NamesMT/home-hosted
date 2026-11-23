/**
 * How a health probe's latency sits, decided **once**.
 *
 * `responseMs` is rendered three times — the detail tile's number, the sparkline under it, and the
 * list row's cell — and each restating its own thresholds let a latency of `1500` read `danger` in
 * one surface and `warn` in another.
 *
 * The thresholds are a fixed decision by nature — `healthSchema` has no latency field for a person
 * to set — so, like `hostCpuBand`, the band is a constant that one predicate owns and a surface
 * paints. `cpu-scale.ts` is the same shape for a capacity.
 */

/** A probe slower than this is worth a warning; past `PROBE_DANGER_MS` it is an unhealthy entry. */
export const PROBE_WARN_MS = 300
export const PROBE_DANGER_MS = 1000

/**
 * A reading is `unknown` when it does not exist — a stopped entry, or a probe that has not run.
 *
 * It is its own band rather than `ok`: the tile painted an absent reading `--ok` (`probeColor` read
 * `responseMs ?? 0`), which is a healthy verdict for a number nobody measured.
 */
export type ProbeBand = 'unknown' | 'ok' | 'warn' | 'danger'

/** The band a probe latency falls in. `null` is a reading that does not exist. */
export function probeBand(responseMs: number | null | undefined): ProbeBand {
  if (responseMs === null || responseMs === undefined || !Number.isFinite(responseMs))
    return 'unknown'
  if (responseMs >= PROBE_DANGER_MS)
    return 'danger'
  if (responseMs >= PROBE_WARN_MS)
    return 'warn'
  return 'ok'
}
