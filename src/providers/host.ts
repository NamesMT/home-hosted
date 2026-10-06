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

async function readSwapUsedPercent(): Promise<number> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('sysctl', ['-n', 'vm.swapusage'], { timeout: 3000 })
      const total = /total\s*=\s*([\d.]+)M/.exec(stdout)?.[1]
      const used = /used\s*=\s*([\d.]+)M/.exec(stdout)?.[1]
      const totalMb = Number.parseFloat(total ?? '0')
      const usedMb = Number.parseFloat(used ?? '0')
      return totalMb > 0 ? (usedMb / totalMb) * 100 : 0
    }
    catch {
      return 0
    }
  }

  if (process.platform === 'win32') {
    try {
      const script = 'Get-CimInstance Win32_PageFileUsage | Select-Object AllocatedBaseSize,CurrentUsage | ConvertTo-Csv -NoTypeInformation'
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000 })
      const line = stdout.split(/\r?\n/).slice(1).find(entry => entry.trim().length > 0)
      const cells = (line ?? '').split(',').map(entry => entry.replace(/"/g, '').trim())
      const totalMb = Number.parseFloat(cells[0] ?? '0')
      const usedMb = Number.parseFloat(cells[1] ?? '0')
      return totalMb > 0 ? (usedMb / totalMb) * 100 : 0
    }
    catch {
      return 0
    }
  }

  return 0
}

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
 * Best-effort CPU temperature from Linux thermal zones / hwmon. macOS and
 * Windows expose no unprivileged sensor, so those platforms report null and the
 * UI simply hides the reading.
 */
export function cpuTemperature(): number | null {
  const readings: number[] = []

  const inspect = (file: string): void => {
    try {
      const raw = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
      if (!Number.isFinite(raw))
        return
      const celsius = raw / 1000 // both interfaces report millidegrees
      if (celsius > 0 && celsius < 150)
        readings.push(celsius)
    }
    catch {
      // Absent on this machine.
    }
  }

  try {
    for (const zone of fs.readdirSync('/sys/class/thermal')) {
      if (zone.startsWith('thermal_zone'))
        inspect(path.join('/sys/class/thermal', zone, 'temp'))
    }
  }
  catch {
    // No thermal class.
  }

  try {
    for (const hwmon of fs.readdirSync('/sys/class/hwmon')) {
      const dir = path.join('/sys/class/hwmon', hwmon)
      for (const entry of fs.readdirSync(dir)) {
        if (/^temp\d+_input$/.test(entry))
          inspect(path.join(dir, entry))
      }
    }
  }
  catch {
    // No hwmon.
  }

  return readings.length > 0 ? Math.max(...readings) : null
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
 * Samples the machine itself: the failures a home server actually dies from are
 * a full disk, exhausted memory or a runaway load — none of which a port probe
 * can see.
 */
export async function sampleHost(config: HostConfig, resolvePath: (target: string) => string): Promise<HostView> {
  const cpus = os.cpus().length || 1
  const loadAvg = os.loadavg()
  const memory = memoryInfo()
  // `os.loadavg()` is always zero on Windows, so per-cpu load would alert forever.
  if (process.platform === 'win32')
    loadAvg.fill(0)
  if (memory.swapUsedPercent === 0 && process.platform !== 'linux') {
    memory.swapUsedPercent = await swapUsedPercent()
  }
  const tempCelsius = cpuTemperature()

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
    uptimeMs: os.uptime() * 1000,
    memoryUsedPercent: 0,
    swapUsedPercent: 0,
    tempCelsius: null,
    disks: [],
    alerts: [],
    sampledAt: null,
  }
}
