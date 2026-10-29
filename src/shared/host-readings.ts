/**
 * The host's measurements, and the one place that decides a sample exists.
 *
 * `emptyHostView()` is what `HostMonitor` starts from, and it is also the frame a panel keeps for
 * ever when host vitals are switched off: `sampledAt: null`, with **every value zero** because the
 * wire type says `number`. `/api/metrics` refuses to publish those zeros — a scrape has no page to
 * qualify a number, so a `0` it invents silences the alert rule that exists to catch a full disk.
 * The panel's own pages read the same frame and printed it: `0.0%` memory, `0.0%` swap, `0.00`
 * load, under a head that says "sampling off". On a homelab box being told memory is at 0% is the
 * same lie as a dashboard being told it, told to the person instead.
 *
 * So `sampledAt === null` means "nothing has been measured" and every reading here is `null`.
 * The zeros stay on the wire: an older overridden UI under `.hh/.ui` reads `memoryUsedPercent` as a
 * `number` and calls `.toFixed()` on it, so a nullable field would crash it — the absence is decided
 * where it is rendered, once, instead.
 *
 * `cpus` and `uptimeMs` are **not** readings: they describe the machine, not a sample, and the
 * empty frame already reports them truthfully.
 */

/** What the predicate needs: the sample's stamp and the numbers the frame carries. */
export interface HostReadingSource {
  sampledAt: number | null
  cpus: number
  cpuUsedPercent?: number | null
  memoryUsedPercent: number
  swapUsedPercent: number
  loadAvg: number[]
  tempCelsius: number | null
  disks: Array<{ path: string, totalBytes: number, freeBytes: number, usedPercent: number }>
}

/** One host sample, with every measurement absent until the host has been sampled. */
export interface HostReadings {
  /** Whether the frame carries a sample at all. */
  sampled: boolean
  cpuUsedPercent: number | null
  memoryUsedPercent: number | null
  swapUsedPercent: number | null
  load1m: number | null
  load5m: number | null
  load15m: number | null
  /**
   * The 1-minute load as a share of one core. Load is a **count of runnable tasks**, so this is a
   * count per core, never a percentage — `1.00` is one core's worth of work.
   */
  loadPerCpu: number | null
  tempCelsius: number | null
  disks: HostReadingSource['disks']
}

const NOTHING_SAMPLED: HostReadings = {
  sampled: false,
  cpuUsedPercent: null,
  memoryUsedPercent: null,
  swapUsedPercent: null,
  load1m: null,
  load5m: null,
  load15m: null,
  loadPerCpu: null,
  tempCelsius: null,
  disks: [],
}

/** A number the frame carries, or null when it carries none. */
function present(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The readings of one host frame; a missing frame is the same as an unsampled one. */
export function hostReadings(host: HostReadingSource | null | undefined): HostReadings {
  if (host === null || host === undefined)
    return NOTHING_SAMPLED
  const sampled = host.sampledAt !== null
  if (!sampled)
    return { ...NOTHING_SAMPLED, disks: [] }
  // A truthy `sampledAt` is the only thing that makes a zero a reading: an honestly idle box
  // reports 0%, and that must survive as 0 rather than becoming an absence of its own.
  const load1m = present(host.loadAvg[0])
  const cpus = present(host.cpus)
  return {
    sampled: true,
    cpuUsedPercent: present(host.cpuUsedPercent),
    memoryUsedPercent: present(host.memoryUsedPercent),
    swapUsedPercent: present(host.swapUsedPercent),
    load1m,
    load5m: present(host.loadAvg[1]),
    load15m: present(host.loadAvg[2]),
    loadPerCpu: load1m === null ? null : load1m / Math.max(1, cpus ?? 1),
    tempCelsius: present(host.tempCelsius),
    disks: host.disks,
  }
}
