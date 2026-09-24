import type { HostConfig, HostView } from '#src/shared/contracts'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Swap usage per platform: /proc on Linux, sysctl on macOS, CIM on Windows. */
async function swapUsedPercent(): Promise<number> {
  if (process.platform === 'linux')
    return 0 // filled by memoryInfo below

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

/** `/proc/meminfo` counts cache as available, which `os.freemem()` does not. */
export function memoryInfo(): { memoryUsedPercent: number, swapUsedPercent: number } {
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8')
    const read = (key: string): number => Number.parseInt(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? '0', 10)
    const total = read('MemTotal')
    const available = read('MemAvailable')
    const swapTotal = read('SwapTotal')
    const swapFree = read('SwapFree')

    return {
      memoryUsedPercent: total > 0 ? ((total - available) / total) * 100 : 0,
      swapUsedPercent: swapTotal > 0 ? ((swapTotal - swapFree) / swapTotal) * 100 : 0,
    }
  }
  catch {
    const total = os.totalmem()
    const free = os.freemem()
    return { memoryUsedPercent: total > 0 ? ((total - free) / total) * 100 : 0, swapUsedPercent: 0 }
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
      usedPercent: totalBytes > 0 ? ((totalBytes - freeBytes) / totalBytes) * 100 : 0,
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
