/**
 * The host's measurements, and the one place that decides a sample exists.
 *
 * `sampledAt === null` means nothing has been measured, and every reading here is `null`. The zeros
 * stay on the wire because an older overridden UI calls `.toFixed()` on a `number`, so the absence is
 * decided where it is rendered rather than by a nullable field.
 *
 * `cpus`, `uptimeMs` and the alert thresholds are not readings: they describe the machine or the
 * configured bar, not a sample.
 */

/** The load per cpu a panel notifies on when nothing else is configured. */
export const LOAD_ALERT_PER_CPU_DEFAULT = 2

/** The alert thresholds a percentage reading is banded against, when the frame carries none. */
export const HOST_ALERT_DEFAULTS = { diskUsedPercent: 90, memoryUsedPercent: 90, swapUsedPercent: 50, tempCelsius: 85 } as const

/** A configurable alert threshold, as it travels on the frame. */
export interface HostAlertThresholds {
  /** `host.diskUsedPercent` — the threshold the panel notifies on, `0` disabling it. */
  diskUsedPercentAlert?: number
  /** `host.memoryUsedPercent` — the threshold the panel notifies on, `0` disabling it. */
  memoryUsedPercentAlert?: number
  swapUsedPercentAlert?: number
  tempCelsiusAlert?: number
}

/** One configured filesystem, with the band its own usage is painted in. */
export interface HostDiskReading {
  path: string
  totalBytes: number
  freeBytes: number
  usedPercent: number
  /**
   * How urgent that filesystem's usage is, against `host.diskUsedPercent` — the threshold the panel
   * **notifies** on — else `null` when nothing was measured.
   *
   * It rides on the disk rather than beside the frame because the threshold is per-path usage and a
   * frame can carry several paths; a single `diskBand` next to `memoryBand` would answer for one of
   * them. The band was the last literal: `Gauge`/`Meter` defaulted to `75`/`90` and both
   * noc-console surfaces restated the same pair, which is `hostSchema`'s *default*, so lowering
   * `host.diskUsedPercent` to 80 made the panel notify at 82% while every surface called it `warn`.
   */
  band: HostBand
}

/** What the predicate needs: the sample's stamp and the numbers the frame carries. */
export interface HostReadingSource extends HostAlertThresholds {
  sampledAt: number | null
  /** `false` once sampling is switched off: whatever the frame still carries is no longer current. */
  enabled?: boolean
  /** Readings this sample could not take (Windows load, a failed macOS read); each is absent. */
  unmeasured?: readonly string[]
  cpus: number
  /** The alert thresholds from the panel's own config; absent on a panel that predates the fields. */
  loadAlertPerCpu?: number
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
  /**
   * The readings this sample could not take, because the **platform** cannot (`load` on Windows,
   * `memory`/`swap` when the OS read failed).
   *
   * Distinct from an unsampled frame on purpose: `sampled: false` means "nothing measured yet",
   * while a name here means "measured, and this machine has no such number". A surface that renders
   * `—` for both tells a person on Windows their load average is `0.00` once sampling starts, or
   * leaves them waiting for a value that will never arrive. `[]` when everything was taken.
   */
  unmeasured: readonly string[]
  /**
   * The frame is unsampled **and** the panel has a sample it is deliberately not showing (sampling
   * switched off, or a sample older than three intervals). `sampledAt` carries its stamp, so a
   * surface can say "last sampled 4m ago" rather than "waiting for the first sample" — which for a
   * switched-off panel would never arrive.
   */
  staleSince: number | null
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
  /** Each configured filesystem, carrying its own band. Empty when nothing was sampled. */
  disks: HostDiskReading[]
  /**
   * How urgent that per-cpu load is: `null` when nothing was measured (an absent reading has no
   * band of its own, or a zero would read as healthy), else the alert threshold it crossed.
   */
  loadBand: HostBand
  /**
   * The same verdict for the three percentage readings, each against the threshold the panel
   * **notifies** on — `null` when nothing was measured. A surface paints `thresholdBand`, never a
   * literal: the swap bar used to call 50% `warn` while the alert fired there, and a raised
   * `tempCelsius` left a box painted `danger` for a notification that never arrives.
   */
  memoryBand: HostBand
  swapBand: HostBand
  tempBand: HostBand
}

/** A reading's urgency, or `null` when there is no reading to judge. */
export type HostBand = 'ok' | 'warn' | 'danger' | null

const NOTHING_SAMPLED: HostReadings = {
  sampled: false,
  unmeasured: [],
  staleSince: null,
  cpuUsedPercent: null,
  memoryUsedPercent: null,
  swapUsedPercent: null,
  load1m: null,
  load5m: null,
  load15m: null,
  loadPerCpu: null,
  tempCelsius: null,
  disks: [],
  loadBand: null,
  memoryBand: null,
  swapBand: null,
  tempBand: null,
}

/** A number the frame carries, or null when it carries none. */
function present(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * The band for the host's own CPU share, which has no configurable alert — one constant, not a
 * literal pair at each surface.
 */
export const HOST_CPU_BAND = { warnAt: 80, dangerAt: 95 } as const

/** The band for a host cpu share, against {@link HOST_CPU_BAND}. */
export function hostCpuBand(percent: number | null): HostBand {
  if (percent === null || !Number.isFinite(percent))
    return null
  // An explicit pair, not `thresholdBand`'s 70%-of-the-alert: these are two chosen numbers, and
  // deriving one from the other moved the warn line to 66.5 for a band written as 80/95.
  if (percent >= HOST_CPU_BAND.dangerAt)
    return 'danger'
  if (percent >= HOST_CPU_BAND.warnAt)
    return 'warn'
  return 'ok'
}

/**
 * The full scale of a temperature dial: the threshold the panel **notifies** on, since a temperature
 * has no natural `100`. `0` disables the alert and leaves no scale, so the older default is kept
 * rather than dividing by zero.
 */
export function tempScale(alertAt: number | undefined): number {
  return alertAt === undefined || !Number.isFinite(alertAt) || alertAt <= 0 ? HOST_ALERT_DEFAULTS.tempCelsius : alertAt
}

/**
 * How full a temperature dial is, as the percentage a `Gauge`/bar draws: a share of `tempScale`.
 *
 * `null` when nothing was measured — an absent reading has no dial, the same rule every other
 * reading on the frame follows.
 */
export function tempDialPercent(temp: number | null | undefined, alertAt: number | undefined): number | null {
  const value = present(temp)
  if (value === null)
    return null
  return (value / tempScale(alertAt)) * 100
}

/**
 * How a reading sits against the threshold the panel notifies on: `danger` *at* the threshold, because
 * the alert fires there. `0` disables that alert, so the band is `ok` — a red box for a notification
 * that never arrives is the same defect as inventing a reading.
 */
function thresholdBand(value: number | null, alertAt: number | undefined, fallback: number): HostBand {
  if (value === null || !Number.isFinite(value))
    return null
  // An older panel sends no threshold, and it alerted on the default — so that is the band to draw.
  const threshold = alertAt === undefined || !Number.isFinite(alertAt) ? fallback : alertAt
  if (threshold <= 0)
    return 'ok'
  if (value >= threshold)
    return 'danger'
  if (value >= threshold * 0.7)
    return 'warn'
  return 'ok'
}

/** The readings of one host frame; a missing frame is the same as an unsampled one. */
export function hostReadings(host: HostReadingSource | null | undefined): HostReadings {
  if (host === null || host === undefined)
    return NOTHING_SAMPLED
  // A frame kept after sampling was switched off is the last reading, not a current one.
  const sampled = host.sampledAt !== null && host.enabled !== false
  if (!sampled) {
    // `sampledAt` survives on the frame when the panel keeps the last reading (sampling switched
    // off, or a sample older than three intervals). That stamp is *why* there is nothing to show,
    // and a surface can say "last sampled 4m ago" instead of "waiting" — which never ends.
    return { ...NOTHING_SAMPLED, staleSince: host.sampledAt, disks: [] }
  }
  // A truthy `sampledAt` is the only thing that makes a zero a reading: an honestly idle box
  // reports 0%, and that must survive as 0 rather than becoming an absence of its own — unless the
  // frame says this sample could not take it (Windows has no load average).
  const unmeasured = new Set(host.unmeasured ?? [])
  const measured = (name: string, value: number | null | undefined): number | null => unmeasured.has(name) ? null : present(value)
  const load1m = measured('load', host.loadAvg[0])
  const cpus = present(host.cpus)
  const loadPerCpu = load1m === null ? null : load1m / Math.max(1, cpus ?? 1)
  const memoryUsedPercent = measured('memory', host.memoryUsedPercent)
  const swapUsedPercent = measured('swap', host.swapUsedPercent)
  const tempCelsius = present(host.tempCelsius)
  return {
    sampled: true,
    // The platform's own limits, carried out so a surface can say "unavailable on this platform"
    // rather than an absent-looking dash beside a number that was taken. Narrowed to the three the
    // wire names, so a future reading this module does not band is not silently advertised.
    unmeasured: [...unmeasured].filter(name => ['load', 'memory', 'swap'].includes(name)),
    staleSince: null,
    cpuUsedPercent: present(host.cpuUsedPercent),
    memoryUsedPercent,
    swapUsedPercent,
    load1m,
    load5m: measured('load', host.loadAvg[1]),
    load15m: measured('load', host.loadAvg[2]),
    loadPerCpu,
    loadBand: thresholdBand(loadPerCpu, host.loadAlertPerCpu, LOAD_ALERT_PER_CPU_DEFAULT),
    memoryBand: thresholdBand(memoryUsedPercent, host.memoryUsedPercentAlert, HOST_ALERT_DEFAULTS.memoryUsedPercent),
    swapBand: thresholdBand(swapUsedPercent, host.swapUsedPercentAlert, HOST_ALERT_DEFAULTS.swapUsedPercent),
    tempBand: thresholdBand(tempCelsius, host.tempCelsiusAlert, HOST_ALERT_DEFAULTS.tempCelsius),
    tempCelsius,
    // Each disk is banded against the same configured alert, on its own usage.
    disks: host.disks.map(disk => ({
      ...disk,
      band: thresholdBand(present(disk.usedPercent), host.diskUsedPercentAlert, HOST_ALERT_DEFAULTS.diskUsedPercent),
    })),
  }
}
