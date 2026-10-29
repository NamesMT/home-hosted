/**
 * How a server's `cpuPercent` sits on **this machine**.
 *
 * A server's figure is summed over its process tree, so it counts *cores*: `400` is four busy cores
 * on any box, and on a 24-core host that is a sixth of the machine — normal work, not an emergency.
 * A chart with a fixed ceiling of `100` clipped those points to the top edge, and a colour band with
 * fixed `40`/`80` thresholds painted that busy worker red. Both answers were wrong in the same way:
 * they measured one core and called it the machine.
 *
 * So the scale is `cpus × 100`, and it is decided **here** rather than restated at each surface. The
 * stock card and detail page, and the noc-console list and detail page, all read it — the fourth copy
 * is what drifted, leaving the detail page's number red while its own sparkline stayed accent.
 */

/** The chart's full scale: the whole machine's capacity in percent, floored at one core. */
export function cpuCapacity(cpus: number | null | undefined): number {
  // A missing host frame (or a nonsense zero) must not divide by zero or clamp every reading to the
  // top, so an unknown core count is read as one core — the same answer the fixed-100 charts gave.
  const cores = typeof cpus === 'number' && Number.isFinite(cpus) && cpus > 0 ? cpus : 1
  return Math.max(100, cores * 100)
}

/** How urgent a cpu reading is, on that scale. */
export type CpuBand = 'unknown' | 'ok' | 'warn' | 'danger'

/**
 * The band a reading falls in, as a share of `capacity`.
 *
 * `null` is a reading that does not exist — a stopped entry — and it is its own band rather than
 * `'ok'`, because a missing measurement must never be painted as a healthy one. The thresholds are
 * the ones the per-core bands used (40% and 80%), now taken against the machine.
 */
export function cpuBand(cpuPercent: number | null | undefined, cpus: number | null | undefined): CpuBand {
  if (cpuPercent === null || cpuPercent === undefined || !Number.isFinite(cpuPercent))
    return 'unknown'
  const capacity = cpuCapacity(cpus)
  if (cpuPercent >= capacity * 0.8)
    return 'danger'
  if (cpuPercent >= capacity * 0.4)
    return 'warn'
  return 'ok'
}
