import type { ProcessResources } from '#src/shared/contracts'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

interface ProcRow {
  pid: number
  ppid: number
  rssKb: number
  /** Cumulative CPU seconds, when the platform reports it (Linux, Windows). */
  cpuSeconds?: number
  /** Instantaneous/decaying CPU percent, when the platform reports it (macOS). */
  cpuPercent?: number
}

export function parsePsOutput(text: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4)
      continue
    const [pid, ppid, rss, cpu] = parts.map(entry => Number.parseFloat(entry))
    if (pid === undefined || ppid === undefined || rss === undefined || !Number.isFinite(pid))
      continue
    rows.push({ pid, ppid, rssKb: rss, cpuPercent: Number.isFinite(cpu) ? cpu : undefined })
  }
  return rows
}

/** CSV from `Get-CimInstance ... | ConvertTo-Csv`, or wmic's `/format:csv`. */
export function parseWindowsCsv(text: string): ProcRow[] {
  const rows: ProcRow[] = []
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0)
  const header = lines.shift()
  if (header === undefined)
    return rows

  const columns = header.split(',').map(entry => entry.replace(/"/g, '').trim().toLowerCase())
  const index = (name: string): number => columns.indexOf(name.toLowerCase())
  const pidAt = index('ProcessId')
  const ppidAt = index('ParentProcessId')
  const rssAt = index('WorkingSetSize')
  const kernelAt = index('KernelModeTime')
  const userAt = index('UserModeTime')

  for (const line of lines) {
    const cells = line.split(',').map(entry => entry.replace(/"/g, '').trim())
    const pid = Number.parseInt(cells[pidAt] ?? '', 10)
    if (!Number.isFinite(pid))
      continue

    // A missing time column must read as "unknown", never as zero CPU.
    const kernel = kernelAt >= 0 ? Number.parseInt(cells[kernelAt] ?? '', 10) : Number.NaN
    const user = userAt >= 0 ? Number.parseInt(cells[userAt] ?? '', 10) : Number.NaN
    const hasTimes = Number.isFinite(kernel) && Number.isFinite(user)

    rows.push({
      pid,
      ppid: Number.parseInt(cells[ppidAt] ?? '', 10) || 0,
      // WorkingSetSize is bytes on Windows; the sampler sums kilobytes.
      rssKb: (Number.parseInt(cells[rssAt] ?? '', 10) || 0) / 1024,
      cpuSeconds: hasTimes ? (kernel + user) / 1e7 /* 100ns units */ : undefined,
    })
  }

  return rows
}

let clockTicks: number | null = null

/** Linux jiffies per second; `getconf` is POSIX, with the usual default behind it. */
async function getClockTicks(): Promise<number> {
  if (clockTicks !== null)
    return clockTicks
  try {
    const { stdout } = await execFileAsync('getconf', ['CLK_TCK'], { timeout: 2000 })
    const parsed = Number.parseInt(stdout.trim(), 10)
    clockTicks = Number.isFinite(parsed) && parsed > 0 ? parsed : 100
  }
  catch {
    clockTicks = 100
  }
  return clockTicks
}

/**
 * `/proc/<pid>/stat` needs care: the comm field is parenthesised and may itself
 * contain spaces or parentheses, so parsing starts after the last `)`.
 */
function parseStat(pid: number, content: string): ProcRow | null {
  const close = content.lastIndexOf(')')
  if (close < 0)
    return null
  const fields = content.slice(close + 2).split(' ')
  const ppid = Number.parseInt(fields[1] ?? '', 10)
  const utime = Number.parseInt(fields[11] ?? '', 10)
  const stime = Number.parseInt(fields[12] ?? '', 10)
  const rssPages = Number.parseInt(fields[21] ?? '', 10)

  if (!Number.isFinite(ppid) || !Number.isFinite(utime) || !Number.isFinite(stime))
    return null
  return { pid, ppid, rssKb: Number.isFinite(rssPages) ? rssPages * 4 : 0, cpuSeconds: utime + stime }
}

async function readLinux(): Promise<ProcRow[]> {
  const rows: ProcRow[] = []
  let names: string[] = []
  try {
    names = fs.readdirSync('/proc')
  }
  catch {
    return rows
  }

  for (const name of names) {
    if (!/^\d+$/.test(name))
      continue
    const pid = Number.parseInt(name, 10)
    try {
      const row = parseStat(pid, fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
      if (row === null)
        continue
      // VmRSS is exact; the stat page count assumes a 4K page.
      try {
        const vmRss = /^VmRSS:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]
        if (vmRss !== undefined)
          row.rssKb = Number.parseInt(vmRss, 10)
      }
      catch {
        // Fall back to the page count.
      }
      rows.push(row)
    }
    catch {
      // Exited between listing and reading.
    }
  }

  return rows
}

async function readPosix(): Promise<ProcRow[]> {
  const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,ppid=,rss=,%cpu='], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 })
  return parsePsOutput(stdout)
}

async function readWindows(): Promise<ProcRow[]> {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Csv -NoTypeInformation'
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 8000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return parseWindowsCsv(stdout)
  }
  catch {
    try {
      const { stdout } = await execFileAsync('wmic', [
        'process',
        'get',
        'ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime',
        '/format:csv',
      ], { timeout: 8000, maxBuffer: 16 * 1024 * 1024 })
      return parseWindowsCsv(stdout)
    }
    catch {
      // Neither tool is available; resource sampling degrades to "unknown".
      return []
    }
  }
}

async function readProcesses(): Promise<ProcRow[]> {
  if (process.platform === 'linux')
    return readLinux()
  if (process.platform === 'win32')
    return readWindows()
  return readPosix()
}

function collectTree(rootPid: number, children: Map<number, number[]>): number[] {
  const pids: number[] = []
  const stack = [rootPid]
  const seen = new Set<number>()

  while (stack.length > 0) {
    const pid = stack.pop()!
    if (seen.has(pid))
      continue
    seen.add(pid)
    pids.push(pid)
    for (const child of children.get(pid) ?? []) stack.push(child)
  }

  return pids
}

/**
 * The roots and every descendant of theirs, from one scan of the process table.
 *
 * Ownership has to mean the *tree*: a persistent entry runs under a nanny, and a
 * wrapper entry spawns the real server one generation down. Both keep the pid the
 * panel recorded, but the process holding the port is a descendant of it — and a
 * descendant classified as a stranger is one `kill`/`free-port` away from stopping
 * a server this panel is responsible for.
 *
 * A backend that cannot run answers with the roots alone, which is the old,
 * narrower behaviour rather than a wrong one.
 */
export async function processTreePids(roots: number[]): Promise<Set<number>> {
  const pids = new Set<number>(roots)
  if (roots.length === 0)
    return pids

  try {
    const rows = await readProcesses()
    const children = new Map<number, number[]>()
    for (const row of rows) {
      const siblings = children.get(row.ppid) ?? []
      siblings.push(row.pid)
      children.set(row.ppid, siblings)
    }
    for (const root of roots) {
      for (const pid of collectTree(root, children)) pids.add(pid)
    }
  }
  catch {
    // Sampling already treats an unreadable table as "nothing to say".
  }

  return pids
}

/**
 * Samples CPU and RSS for a process *and its descendants*.
 *
 * Descendants matter: a wrapper that spawns the real server detached (the
 * omniroute CLI does) owns the tree, and only the tree's RSS means anything.
 *
 * Backends: `/proc` on Linux, `ps` on macOS/other POSIX, and Win32_Process via
 * PowerShell (wmic as a fallback) on Windows. When a backend cannot run, samples
 * are null rather than wrong.
 */
export class ProcessSampler {
  private readonly previous = new Map<number, { cpuSeconds: number, at: number }>()

  async sample(rootPid: number, now = Date.now()): Promise<ProcessResources | null> {
    const samples = await this.sampleMany([rootPid], now)
    return samples.get(rootPid) ?? null
  }

  async sampleMany(rootPids: number[], now = Date.now()): Promise<Map<number, ProcessResources | null>> {
    const results = new Map<number, ProcessResources | null>()
    if (rootPids.length === 0)
      return results

    let rows: ProcRow[] = []
    try {
      rows = await readProcesses()
    }
    catch {
      rows = []
    }

    const byPid = new Map(rows.map(row => [row.pid, row]))
    const children = new Map<number, number[]>()
    for (const row of rows) {
      const siblings = children.get(row.ppid) ?? []
      siblings.push(row.pid)
      children.set(row.ppid, siblings)
    }

    for (const rootPid of rootPids) {
      if (!byPid.has(rootPid)) {
        this.previous.delete(rootPid)
        results.set(rootPid, null)
        continue
      }

      const pids = collectTree(rootPid, children)
      let rssKb = 0
      let cpuSeconds: number | null = 0
      let percentAverage: number | null = null

      for (const pid of pids) {
        const row = byPid.get(pid)
        if (!row)
          continue
        rssKb += row.rssKb
        if (row.cpuSeconds === undefined)
          cpuSeconds = null
        else if (cpuSeconds !== null)
          cpuSeconds += row.cpuSeconds
        if (row.cpuPercent !== undefined)
          percentAverage = (percentAverage ?? 0) + row.cpuPercent
      }

      let cpuPercent: number | null = percentAverage
      if (cpuPercent === null && cpuSeconds !== null) {
        if (process.platform === 'linux') {
          const ticks = await getClockTicks()
          cpuSeconds /= ticks
        }

        const before = this.previous.get(rootPid)
        if (before !== undefined && now > before.at) {
          const elapsedSeconds = (now - before.at) / 1000
          const usedSeconds = cpuSeconds - before.cpuSeconds
          if (elapsedSeconds > 0 && usedSeconds >= 0)
            cpuPercent = (usedSeconds / elapsedSeconds) * 100
        }
        this.previous.set(rootPid, { cpuSeconds, at: now })
      }
      else {
        this.previous.delete(rootPid)
      }

      results.set(rootPid, {
        cpuPercent: cpuPercent === null ? null : Math.round(cpuPercent * 10) / 10,
        rssBytes: Math.round(rssKb * 1024),
        processes: pids.length,
        sampledAt: now,
      })
    }

    return results
  }

  forget(rootPid: number): void {
    this.previous.delete(rootPid)
  }
}

/**
 * Does this process carry the environment the supervisor gave the entry?
 *
 * A program that restarts itself — especially a plugin doing it — leaves behind a
 * detached process that still inherits `HHOSTED_SERVER_ID`, and that marker is what
 * tells a legitimate successor apart from a stranger squatting on the port.
 *
 * Linux reads `/proc`; macOS asks `ps -E`; Windows has no per-process environment,
 * so the answer is always "no" there and ownership falls back to the port policy.
 */
export async function processCarriesServerId(pid: number, serverId: string): Promise<boolean> {
  if (serverId.length === 0)
    return false
  const needle = `HHOSTED_SERVER_ID=${serverId}`

  if (process.platform === 'linux') {
    try {
      const raw = await fs.promises.readFile(`/proc/${pid}/environ`, 'utf8')
      return raw.split('\0').includes(needle)
    }
    catch {
      return false
    }
  }

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-E', '-ww', '-o', 'command='], { timeout: 3000 })
      // Values with spaces are unquoted in this output, so the marker is matched as a word.
      return new RegExp(`(?:^|\\s)${needle}(?:\\s|$)`).test(stdout)
    }
    catch {
      return false
    }
  }

  return false
}
