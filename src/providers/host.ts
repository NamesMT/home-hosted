import type { HostConfig, HostView } from '#src/shared/contracts'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * How long a swap reading is reused.
 *
 * Reading swap off Linux costs a *process spawn*: `sysctl` on macOS, and a full PowerShell
 * start on Windows, where `wmic` no longer exists. The host is sampled every 15 s by default,
 * so that was 5,760 spawns a day — minutes of process churn for one number that moves slowly
 * and only feeds an alert threshold and a Prometheus gauge.
 *
 * A stale-by-a-minute reading is not a lie anyone acts on, and the alternative is worse: the
 * spawn happens inside the sample, so it also delays the whole state frame.
 */
const SWAP_CACHE_MS = 60_000

let swapCache: { at: number, percent: number } | null = null

/**
 * Whether a cached reading may be reused.
 *
 * Separate from the reading itself so the rule can be tested anywhere — the read is
 * `sysctl`/PowerShell, which no CI runner but macOS and Windows can perform, and a bug here
 * would be one that only shows up as either a stale alert or a spawn storm.
 *
 * A stamp in the future (a backwards wall-clock step) counts as stale: with a plain
 * `now - at < ttl` it computes a negative age, which is "fresh", and the reading would stick
 * until wall time caught back up — potentially hours after an NTP correction.
 */
export function isSwapCacheFresh(cache: { at: number } | null, now: number, ttlMs = SWAP_CACHE_MS): boolean {
  if (cache === null)
    return false
  const age = now - cache.at
  return age >= 0 && age < ttlMs
}

/** Swap usage per platform: /proc on Linux, sysctl on macOS, CIM on Windows. */
async function swapUsedPercent(now = Date.now()): Promise<number> {
  if (process.platform === 'linux')
    return 0 // filled by memoryInfo below

  if (isSwapCacheFresh(swapCache, now))
    return swapCache!.percent

  const percent = await readSwapUsedPercent()
  swapCache = { at: now, percent }
  return percent
}

/**
 * `sysctl -n vm.swapusage` as a percentage. Pure, so the arithmetic is testable with the readings
 * the platform can actually produce rather than only the ones a runner happens to have.
 */
export function swapPercentFromSysctl(stdout: string): number {
  const total = /total\s*=\s*([\d.]+)M/.exec(stdout)?.[1]
  const used = /used\s*=\s*([\d.]+)M/.exec(stdout)?.[1]
  const totalMb = Number.parseFloat(total ?? '0')
  const usedMb = Number.parseFloat(used ?? '0')
  // `usedPercent` takes what is *free*, so pass the remainder. macOS counts compressed swap, where
  // `used` can exceed `total` — and the swap alert is `used >= threshold`, so a negative silently
  // suppresses it.
  return usedPercent(Math.max(0, totalMb - usedMb), totalMb)
}

/** One `Win32_PageFileUsage` CSV row as a percentage; see `swapPercentFromSysctl` for the clamp. */
export function swapPercentFromPageFile(stdout: string): number {
  const line = stdout.split(/\r?\n/).slice(1).find(entry => entry.trim().length > 0)
  const cells = (line ?? '').split(',').map(entry => entry.replace(/"/g, '').trim())
  const totalMb = Number.parseFloat(cells[0] ?? '0')
  const usedMb = Number.parseFloat(cells[1] ?? '0')
  // `CurrentUsage` can exceed `AllocatedBaseSize` when the pagefile has grown since the snapshot.
  return usedPercent(Math.max(0, totalMb - usedMb), totalMb)
}

export async function readSwapUsedPercent(): Promise<number> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('sysctl', ['-n', 'vm.swapusage'], { timeout: 3000 })
      return swapPercentFromSysctl(stdout)
    }
    catch {
      return 0
    }
  }

  if (process.platform === 'win32') {
    try {
      const script = 'Get-CimInstance Win32_PageFileUsage | Select-Object AllocatedBaseSize,CurrentUsage | ConvertTo-Csv -NoTypeInformation'
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000 })
      return swapPercentFromPageFile(stdout)
    }
    catch {
      return 0
    }
  }

  return 0
}

/**
 * Cumulative CPU time across every core, split into the two halves a utilisation reading needs.
 *
 * `os.cpus()` is the only CPU source common to Linux, macOS and Windows, and each entry is a
 * cumulative* counter since boot — so a percentage is the delta between two snapshots, never a
 * single read. One core busy for the whole window is 100%; all 8 cores busy is 800%, which is why
 * the per-core figure and the machine-wide figure are not interchangeable.
 */
export interface CpuTimes {
  /** Milliseconds of CPU time spent doing anything but idling, every core summed. */
  busyMs: number
  /** Milliseconds of CPU time across every core, idle included. */
  totalMs: number
}

export function cpuTimesSnapshot(cpus = os.cpus()): CpuTimes {
  let busyMs = 0
  let totalMs = 0
  for (const cpu of cpus) {
    const times = cpu.times
    const idle = times.idle
    // `irq`/`nice` are absent on some platforms' `os.cpus()`; an absent field is zero.
    const busy = times.user + (times.nice ?? 0) + times.sys + (times.irq ?? 0)
    busyMs += busy
    totalMs += busy + idle
  }
  return { busyMs, totalMs }
}

/**
 * Share of the machine's CPU capacity in use between two snapshots, 0–100.
 *
 * `null` when the window is empty or the counters went backwards (a suspended host, a clock
 * resync), because "no reading" is honest while a fabricated 0 reads as "idle". Pure, so the
 * arithmetic is testable against snapshots a runner can construct rather than only the one its
 * own scheduler happens to produce.
 */
export function cpuUsedPercent(previous: CpuTimes, next: CpuTimes): number | null {
  const totalDelta = next.totalMs - previous.totalMs
  const busyDelta = next.busyMs - previous.busyMs
  if (!(totalDelta > 0) || busyDelta < 0)
    return null
  return Math.max(0, Math.min(100, (busyDelta / totalDelta) * 100))
}

/**
 * The last snapshot, kept only long enough to difference against the next.
 *
 * Module state, like `swapCache`, because `sampleHost` is the one host sampler and the *interval*
 * between two calls is what makes the reading mean anything. The first call has no baseline and
 * answers `null` rather than inventing a number.
 */
let previousCpuTimes: CpuTimes | null = null

/**
 * Memory used, as a percentage of what the machine actually has.
 *
 * The definition matters more than the arithmetic, and it differs per platform:
 *
 * - Linux: `/proc/meminfo`'s `MemAvailable` already excludes cache, because Linux counts
 *   page cache as reclaimable. `os.freemem()` happens to read the same value here.
 * - macOS: **`os.freemem()` is wrong for this.** libuv reports `host_statistics64`'s
 *   `free_count` alone, while macOS keeps as much RAM as it can in *inactive* and
 *   speculative* pages — file cache it drops on demand. A perfectly healthy Mac therefore
 *   reads as 90%+ used, which is the report a user brought back from a 0.7.3 panel. Read
 *   `vm_stat` and count what macOS itself counts as available.
 * - Windows: `os.freemem()` is the free physical page count, which is the ordinary reading.
 */

/**
 * How much of `total` is not `free`, as a percentage clamped into `[0, 100]`; 0 when `total` is
 * meaningless.
 *
 * `MemAvailable` is a kernel *estimate* and can exceed `MemTotal`, and `SwapFree` can exceed
 * `SwapTotal` — both make the raw ratio negative. That matters more than a strange display: the
 * alert is `used >= threshold`, so a negative reading silently **suppresses** the memory alert
 * entirely. The fallback branch already clamped for exactly this reason; the `/proc` branch did not,
 * so the two disagreed on the same quantity.
 */
export function usedPercent(free: number, total: number): number {
  if (!(total > 0))
    return 0
  return Math.max(0, Math.min(100, ((total - free) / total) * 100))
}

export function memoryInfo(): { memoryUsedPercent: number, swapUsedPercent: number } {
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8')
    const read = (key: string): number => Number.parseInt(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? '0', 10)

    return {
      memoryUsedPercent: usedPercent(read('MemAvailable'), read('MemTotal')),
      swapUsedPercent: usedPercent(read('SwapFree'), read('SwapTotal')),
    }
  }
  catch {
    const total = os.totalmem()
    const available = availableMemoryBytes(process.platform, os.freemem())
    return {
      memoryUsedPercent: available === null ? 0 : usedPercent(available, total),
      swapUsedPercent: 0,
    }
  }
}

/**
 * Which "available memory" reading a platform's fallback should use.
 *
 * Split out from `memoryInfo` because the branch it decides is otherwise unreachable off
 * macOS: Linux answers from `/proc/meminfo` first, so the fallback never runs there and no
 * Linux test can prove which reader was chosen. Taking the platform and the OS reading as
 * arguments makes the decision testable on any runner, which matters — using the wrong
 * reader here is the whole macOS bug.
 */
export function availableMemoryBytes(platform: NodeJS.Platform, osFree: number, vmStat?: string): number | null {
  if (platform !== 'darwin')
    return osFree
  return macAvailableBytes(vmStat)
}

/**
 * What macOS counts as available: free + inactive + speculative pages.
 *
 * `vm_stat` reports pages, so the page size is needed — and it is not always 4096 (Apple
 * silicon uses 16384 for the physical page size, and `vm_stat` has printed a `page size of`
 * header since macOS 11). Both are handled: the header when it is there, `getpagesize` when
 * it is not.
 *
 * Returns `null` when the reading cannot be taken, so the caller reports "unknown" rather
 * than inventing a percentage.
 */
export function macAvailableBytes(vmStat?: string): number | null {
  try {
    const text = vmStat ?? execFileSync('vm_stat', { timeout: 3000, encoding: 'utf8' })
    const pageSize = Number.parseInt(/page size of (\d+) bytes/.exec(text)?.[1] ?? '', 10)

    const pages = (label: string): number => {
      // "Pages free:                           12345."
      const found = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(text)?.[1]
      return Number.parseInt(found ?? '', 10)
    }

    // Without the header, ask the OS: `sysconf(_SC_PAGESIZE)` through node's own binding.
    const size = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : getPageSize()
    if (!Number.isFinite(size) || size <= 0)
      return null

    let totalPages = 0
    let sawAny = false
    // Free plus everything the OS will hand back without swapping. `purgeable` is counted
    // by macOS as reclaimable, and omitting it under-reports available memory on a Mac
    // running an app that marks memory purgeable.
    for (const label of ['Pages free', 'Pages inactive', 'Pages speculative', 'Pages purgeable']) {
      const value = pages(label)
      if (Number.isFinite(value)) {
        totalPages += value
        sawAny = true
      }
    }

    return sawAny ? totalPages * size : null
  }
  catch {
    return null
  }
}

/** The OS page size, without adding a dependency for one sysconf. */
function getPageSize(): number {
  try {
    // `getconf` is POSIX and present on every macOS; it prints the same value vm_stat uses.
    return Number.parseInt(execFileSync('getconf', ['PAGESIZE'], { timeout: 3000, encoding: 'utf8' }).trim(), 10)
  }
  catch {
    return Number.NaN
  }
}

/**
 * Sensor names that report the **CPU** package/die temperature, best first.
 *
 * `hwmon` exposes one directory per chip and each has a `name`; `thermal_zone` exposes a `type`.
 * A machine has several: `nvme` and `drivemet` are disks, `amdgpu` is a GPU, `acpitz` is the ACPI
 * thermal zone. Taking the maximum over *all* of them and calling it "CPU temp" reported the NVMe's
 * 89 °C as the CPU on any box with one — and fired the temperature alert on a disk.
 */
const CPU_SENSOR = /coretemp|k10temp|zenpower|cpu_thermal|cpu-thermal|x86_pkg_temp|soc_thermal|package/i

/** A fallback that is the machine's own thermal zone rather than a peripheral's. */
const ACPI_SENSOR = /acpitz|acpi/i

export interface TemperatureSensor {
  /** The chip or zone name, e.g. `coretemp`, `nvme`, `x86_pkg_temp`. */
  name: string
  celsius: number
}

/**
 * The CPU temperature, or null when this machine names no CPU sensor.
 *
 * One tier is chosen and the maximum is taken only *within* it — a CPU package reports several
 * dies, so the hottest die is the reading, but a disk's temperature is not a second opinion.
 */
export function pickCpuTemperature(sensors: TemperatureSensor[]): number | null {
  for (const pattern of [CPU_SENSOR, ACPI_SENSOR]) {
    const tier = sensors.filter(sensor => pattern.test(sensor.name)).map(sensor => sensor.celsius)
    if (tier.length > 0)
      return Math.max(...tier)
  }
  return null
}

/**
 * Best-effort CPU temperature from Linux thermal zones / hwmon. macOS and Windows expose no
 * unprivileged sensor, so those platforms report null and both UIs read "n/a" — a WSL2 guest has
 * none either, and the Windows host's `MSAcpi_ThermalZoneTemperature` answers a constant 20 °C
 * regardless of load, so reaching across for it would be a fabricated number rather than a reading.
 */
export function cpuTemperature(): number | null {
  const sensors: TemperatureSensor[] = []

  /** `name` is the sensor's own label; absent means the file could not be read, so skip it. */
  const inspect = (file: string, name: string): void => {
    try {
      const raw = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
      if (!Number.isFinite(raw))
        return
      const celsius = raw / 1000 // both interfaces report millidegrees
      if (celsius > 0 && celsius < 150)
        sensors.push({ name, celsius })
    }
    catch {
      // Absent on this machine.
    }
  }

  try {
    for (const zone of fs.readdirSync('/sys/class/thermal')) {
      if (!zone.startsWith('thermal_zone'))
        continue
      const dir = path.join('/sys/class/thermal', zone)
      let type = ''
      try {
        type = fs.readFileSync(path.join(dir, 'type'), 'utf8').trim()
      }
      catch {
        // A zone with no `type` is unnamed, and an unnamed sensor cannot be claimed as the CPU.
      }
      inspect(path.join(dir, 'temp'), type)
    }
  }
  catch {
    // No thermal class.
  }

  try {
    for (const hwmon of fs.readdirSync('/sys/class/hwmon')) {
      const dir = path.join('/sys/class/hwmon', hwmon)
      let chip = ''
      try {
        chip = fs.readFileSync(path.join(dir, 'name'), 'utf8').trim()
      }
      catch {
        // Unnamed chip: keep reading its files, they are just not attributable to the CPU.
      }
      for (const entry of fs.readdirSync(dir)) {
        if (/^temp\d+_input$/.test(entry))
          inspect(path.join(dir, entry), chip)
      }
    }
  }
  catch {
    // No hwmon.
  }

  return pickCpuTemperature(sensors)
}

async function diskUsage(target: string): Promise<HostView['disks'][number] | null> {
  try {
    const stats = await fs.promises.statfs(target)
    const totalBytes = stats.blocks * stats.bsize
    const freeBytes = stats.bavail * stats.bsize
    return {
      path: target,
      totalBytes,
      freeBytes,
      usedPercent: usedPercent(freeBytes, totalBytes),
    }
  }
  catch {
    return null
  }
}

/**
 * Run the configured temperature command and parse one number out of its stdout.
 *
 * This is the escape hatch for a machine whose kernel exposes no sensor — a WSL2 guest above all,
 * where `/sys/class/hwmon` is empty and the Windows ACPI zone answers a constant 20 °C. The user
 * supplies the command, so it is spawned without a shell and given a timeout: a hung helper must
 * not stall a sample that the whole panel's tick waits on.
 *
 * Only a whole-number or decimal reading in a plausible range is accepted. Anything else answers
 * null, which the UI reads as `n/a` — never a guess, for the same reason a missing sensor is not
 * published as 0.
 */
export async function temperatureFromCommand(command: string, timeoutMs: number): Promise<number | null> {
  const trimmed = command.trim()
  if (trimmed.length === 0)
    return null
  try {
    // Run through a shell: the value is a command *line* the person wrote in their own config, like a
    // server entry's `command`+`args` they could have written instead, and a pipeline
    // (`… | awk '{print $1}'`) cannot be expressed without one. `execFile` picks cmd.exe on Windows
    // and /bin/sh elsewhere; `windowsHide` keeps a console from flashing on a desktop.
    const { stdout } = await execFileAsync(trimmed, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024, shell: true })
    return parseTemperature(stdout)
  }
  catch {
    return null
  }
}

/** The first plausible °C reading in a command's output, or null. Exported for its own tests. */
export function parseTemperature(output: string): number | null {
  // A helper may print a label before the number (`Tctl: 63.9`), so take the first match anywhere.
  const match = /-?\d+(?:\.\d+)?/.exec(output)
  if (match === null)
    return null
  const celsius = Number.parseFloat(match[0])
  if (!Number.isFinite(celsius) || celsius <= 0 || celsius >= 150)
    return null
  return celsius
}

/**
 * The temperature to report: the configured command when there is one, else the built-in probe.
 *
 * The command wins even on a platform whose probe works, because a person who set it did so to
 * override what the panel found.
 */
export async function readTemperature(config: HostConfig): Promise<number | null> {
  if (config.tempCommand.trim().length > 0)
    return temperatureFromCommand(config.tempCommand, config.tempCommandTimeoutMs)
  return cpuTemperature()
}

/**
 * Samples the machine itself: the failures a home server actually dies from are
 * a full disk, exhausted memory or a runaway load — none of which a port probe
 * can see.
 */
export async function sampleHost(config: HostConfig, resolvePath: (target: string) => string): Promise<HostView> {
  const cpus = os.cpus().length || 1
  const loadAvg = os.loadavg()
  const memory = memoryInfo()
  // The deltas are taken at the *start*, so the window covers the whole sample rather than
  // whichever part of it the disk stats and swap spawn happened to leave over.
  const cpuTimes = cpuTimesSnapshot()
  const cpuUsedPercentNow = previousCpuTimes === null ? null : cpuUsedPercent(previousCpuTimes, cpuTimes)
  previousCpuTimes = cpuTimes
  // `os.loadavg()` is always zero on Windows, so per-cpu load would alert forever.
  if (process.platform === 'win32')
    loadAvg.fill(0)
  if (memory.swapUsedPercent === 0 && process.platform !== 'linux') {
    memory.swapUsedPercent = await swapUsedPercent()
  }
  const tempCelsius = await readTemperature(config)

  const disks = (await Promise.all(config.diskPaths.map(entry => diskUsage(resolvePath(entry))))).filter(
    (disk): disk is HostView['disks'][number] => disk !== null,
  )

  const alerts: string[] = []
  for (const disk of disks) {
    if (config.diskUsedPercent > 0 && disk.usedPercent >= config.diskUsedPercent) {
      alerts.push(`disk ${disk.path} is ${disk.usedPercent.toFixed(1)}% full`)
    }
  }
  if (config.memoryUsedPercent > 0 && memory.memoryUsedPercent >= config.memoryUsedPercent) {
    alerts.push(`memory is ${memory.memoryUsedPercent.toFixed(1)}% used`)
  }
  if (config.swapUsedPercent > 0 && memory.swapUsedPercent >= config.swapUsedPercent) {
    alerts.push(`swap is ${memory.swapUsedPercent.toFixed(1)}% used`)
  }
  const loadPerCpu = Number(loadAvg[0] ?? 0) / cpus
  if (config.loadPerCpu > 0 && loadPerCpu >= config.loadPerCpu) {
    alerts.push(`load ${loadPerCpu.toFixed(2)}/cpu exceeds ${config.loadPerCpu}`)
  }
  if (tempCelsius !== null && config.tempCelsius > 0 && tempCelsius >= config.tempCelsius) {
    alerts.push(`cpu temperature is ${tempCelsius.toFixed(0)}°C`)
  }

  return {
    enabled: config.enabled,
    cpus,
    loadAvg: [...loadAvg],
    cpuUsedPercent: cpuUsedPercentNow,
    uptimeMs: os.uptime() * 1000,
    memoryUsedPercent: memory.memoryUsedPercent,
    swapUsedPercent: memory.swapUsedPercent,
    tempCelsius,
    disks,
    alerts,
    sampledAt: Date.now(),
  }
}

export function emptyHostView(config: HostConfig): HostView {
  return {
    enabled: config.enabled,
    cpus: os.cpus().length || 1,
    loadAvg: [0, 0, 0],
    cpuUsedPercent: null,
    uptimeMs: os.uptime() * 1000,
    memoryUsedPercent: 0,
    swapUsedPercent: 0,
    tempCelsius: null,
    disks: [],
    alerts: [],
    sampledAt: null,
  }
}
