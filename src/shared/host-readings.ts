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
 *
 * `loadAlertPerCpu` is not a reading either: it is the threshold the panel *notifies* on, and it
 * travels with the frame so a surface can band the load against the number a person actually
 * chose. `AGENTS.md` names the rule — a verdict is measured against the configured threshold, and
 * one module decides it — after two surfaces hardcoded the default and kept calling a box a person
 * had raised the threshold on `danger`, for a notification that stayed silent.
 */

/**
 * The load per cpu a panel notifies on when nothing else is configured.
 *
 * One home: `hostSchema` defaults to it, and a surface reading a frame from a panel that predates
 * the field bands its load against the same number the older panel alerted on.
 */
export const LOAD_ALERT_PER_CPU_DEFAULT = 2

/**
 * The alert thresholds a percentage reading is banded against, when the frame carries none.
 *
 * One home, the same rule as `LOAD_ALERT_PER_CPU_DEFAULT`: `hostSchema` defaults to these, and a
 * surface reading a frame from a panel that predates the fields bands against the numbers that
 * panel alerted on.
 */
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
 * How a per-cpu load sits against the threshold the panel notifies on.
 *
 * The ratio is what a person configures: `host.loadPerCpu` is the count the alert fires at, so
 * `danger` is that number itself and `warn` is the approach to it. `0` disables the alert in
 * `sampleHost`, so nothing can breach it and the band is `ok` — painting a box red for a
 * notification that will never arrive is the same defect as inventing a reading. It lives here
 * rather than in a component so both UIs share one band, the mistake that produced two hardcoded
 * copies of the default.
 */
export function loadBand(loadPerCpu: number | null, alertPerCpu: number | undefined): HostBand {
  return thresholdBand(loadPerCpu, alertPerCpu, LOAD_ALERT_PER_CPU_DEFAULT)
}

/**
 * The band for the host's own CPU share, which has no configurable alert.
 *
 * `host.cpuUsedPercent` is a share of the whole machine, and `hostSchema` has no threshold for it —
 * so there is nothing a person chose for a surface to follow, and a fixed band is a decision. The
 * decision is *this one*: the two UIs disagreed (noc-console painted 70/90, every stock dial 80/95),
 * so one 75% reading came back `warn` on one page and `ok` on the other — `AGENTS.md`'s "UIs move
 * together" broken by two literal pairs. A real alert would make this a `…Alert` field on the frame
 * like its neighbours; until then it is a constant here, not a pair at each call site.
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
 * How a reading sits against the threshold the panel notifies on.
 *
 * `danger` at the threshold is the whole point: the alert fires there, so a bar that stays `warn`
 * while a notification goes out disagrees with the panel's own verdict. `0` disables that alert in
 * `sampleHost`, so nothing can breach it and the band is `ok`. One rule for the per-cpu load, the
 * three percentages and each disk — they differ only in what the number means, and the mistake this
 * replaced was four surfaces each deciding a band for itself.
 */
export function percentageBand(value: number | null, alertAt: number | undefined, fallback: number): HostBand {
  return thresholdBand(value, alertAt, fallback)
}

/**
 * The full scale of a temperature dial: the threshold the panel **notifies** on.
 *
 * There is no natural `100 °C`, so unlike a percentage a temperature has no scale of its own —
 * the alert is the only number a person configured for it, and it is what the dial is drawn
 * against. `0` disables the alert and leaves no scale to draw, so the default the older panels
 * alerted on is kept rather than dividing by zero.
 *
 * This exists because the *band* was moved onto the frame and the *scale* was not: one stock
 * surface scaled by `tempCelsiusAlert` while the other kept `(tempCelsius / 85) * 100`, so one
 * frame at 60 °C against an alert of 95 drew arcs of `101.19` and `113.10` — the same number
 * fuller on one page than the other. A tone test cannot see that; only the arc can.
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
  const sampled = host.sampledAt !== null
  if (!sampled)
    return { ...NOTHING_SAMPLED, disks: [] }
  // A truthy `sampledAt` is the only thing that makes a zero a reading: an honestly idle box
  // reports 0%, and that must survive as 0 rather than becoming an absence of its own.
  const load1m = present(host.loadAvg[0])
  const cpus = present(host.cpus)
  const loadPerCpu = load1m === null ? null : load1m / Math.max(1, cpus ?? 1)
  return {
    sampled: true,
    cpuUsedPercent: present(host.cpuUsedPercent),
    memoryUsedPercent: present(host.memoryUsedPercent),
    swapUsedPercent: present(host.swapUsedPercent),
    load1m,
    load5m: present(host.loadAvg[1]),
    load15m: present(host.loadAvg[2]),
    loadPerCpu,
    loadBand: loadBand(loadPerCpu, host.loadAlertPerCpu),
    memoryBand: percentageBand(present(host.memoryUsedPercent), host.memoryUsedPercentAlert, HOST_ALERT_DEFAULTS.memoryUsedPercent),
    swapBand: percentageBand(present(host.swapUsedPercent), host.swapUsedPercentAlert, HOST_ALERT_DEFAULTS.swapUsedPercent),
    tempBand: percentageBand(present(host.tempCelsius), host.tempCelsiusAlert, HOST_ALERT_DEFAULTS.tempCelsius),
    tempCelsius: present(host.tempCelsius),
    // Each disk is banded against the same configured alert, on its own usage.
    disks: host.disks.map(disk => ({
      ...disk,
      band: percentageBand(present(disk.usedPercent), host.diskUsedPercentAlert, HOST_ALERT_DEFAULTS.diskUsedPercent),
    })),
  }
}
