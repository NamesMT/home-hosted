import { execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** True when something accepts TCP connections on host:port. */
export function probePort(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (result: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** A port is free when nothing is listening on it (loopback is enough to detect conflicts). */
export async function isPortFree(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
  return !(await probePort(host, port, timeoutMs))
}

/**
 * Kills whatever holds the port, minus `exclude` (the panel's own process tree).
 * Only used as a last resort for wrappers that spawn their real server detached,
 * where a process-group signal cannot reach it.
 */
export async function killPortHolders(port: number, exclude?: ReadonlySet<number>): Promise<number[]> {
  const pids = (await listPortHolders(port)).filter(pid => !exclude?.has(pid))
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    }
    catch {
      // already gone
    }
  }
  return pids
}

/**
 * Signal 0 asks the OS whether the pid still exists, without touching it.
 *
 * `EPERM` means the process is there but is **not ours to signal** — a port holder owned by another
 * user is exactly that. Returning `false` for it made `nannyIsAlive` report a live nanny as gone, so
 * `resumePersistent` consumed its state file and started a second copy of the entry while the first ran
 * on untracked. `helpers/daemon.ts` already had this right; the two predicates now agree.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Linux jiffies per second: the near-universal default, since `/proc` needs no `getconf`. */
const LINUX_HZ = 100

/** When a process started, and whether it has exited but is not reaped yet. */
export interface ProcessBirth {
  /** Epoch ms the process started, as the OS reports it. */
  startMs: number
  /** A zombie: exited, still answering signal 0, and nobody's to signal. */
  zombie: boolean
}

/**
 * `/proc/<pid>/stat` field 22 is the start time in clock ticks since boot, which only
 * becomes an epoch by adding `btime` from `/proc/stat`. Field 3 is the state.
 *
 * The comm field is parenthesised and may itself hold spaces and parentheses, so the
 * fields are counted from after the **last** `)`. Counting from the first would shift
 * every offset for a process whose name contains a `)`, and this value decides whether a
 * live-looking pid is really the daemon.
 */
export function parseProcBirth(content: string, btimeSeconds: number, hz = LINUX_HZ): ProcessBirth | null {
  const close = content.lastIndexOf(')')
  if (close < 0)
    return null
  const fields = content.slice(close + 2).split(' ')
  const ticks = Number.parseInt(fields[19] ?? '', 10)
  if (!Number.isFinite(ticks) || ticks < 0)
    return null
  return { startMs: btimeSeconds * 1000 + (ticks / hz) * 1000, zombie: fields[0] === 'Z' }
}

/**
 * One `ps -o state=,lstart=` row, e.g. `S Wed Oct  7 19:43:26 2026` (macOS, other POSIX).
 * The leading weekday is stripped before parsing: `Date.parse` is not obliged to accept it
 * and it says nothing the date does not.
 */
export function parsePsBirth(output: string): ProcessBirth | null {
  const line = output.trim().split('\n')[0]?.trim() ?? ''
  if (line.length === 0)
    return null
  const [state = '', ...rest] = line.split(/\s+/)
  const startMs = Date.parse(rest.join(' ').replace(/^[A-Z]{3,9}\s+/i, ''))
  if (!Number.isFinite(startMs))
    return null
  return { startMs, zombie: state.startsWith('Z') }
}

/** 100ns ticks between the FILETIME epoch (1601) and the Unix epoch (1970). */
const FILETIME_UNIX_OFFSET_MS = 11644473600000

/**
 * FILETIME ticks (100ns since **1601**, UTC) to a Unix epoch in ms — the shape
 * `DateTime.ToFileTimeUtc()` returns.
 *
 * The epoch matters: `DateTime.Ticks` counts from **0001**, not 1601, and the two differ by
 * 1600 years. Reading the wrong one put every Windows panel ~1600 years in the future, which
 * `processLiveness` then called `recycled` — a live panel that could never signal-stop itself.
 * The PowerShell call below therefore asks for `ToFileTimeUtc()` explicitly, and this is exported
 * so the conversion is pinned by a test.
 */
export function parseFiletime(ticks: number): number | null {
  if (!Number.isFinite(ticks) || ticks <= 0)
    return null
  return ticks / 1e4 - FILETIME_UNIX_OFFSET_MS
}

/**
 * When the pid started, from the platform's own process table. `null` when the platform
 * cannot say — an unreadable `/proc`, no `ps`, or no PowerShell — which the caller must
 * read as "unknown", never as "gone".
 */
export async function processBirth(pid: number): Promise<ProcessBirth | null> {
  if (!Number.isInteger(pid) || pid <= 0)
    return null

  if (process.platform === 'linux') {
    try {
      const [stat, system] = await Promise.all([
        fs.promises.readFile(`/proc/${pid}/stat`, 'utf8'),
        fs.promises.readFile('/proc/stat', 'utf8'),
      ])
      const btime = /^btime (\d+)$/m.exec(system)?.[1]
      if (btime === undefined)
        return null
      return parseProcBirth(stat, Number.parseInt(btime, 10))
    }
    catch {
      return null
    }
  }

  if (process.platform === 'win32') {
    try {
      // `ToFileTimeUtc()`, not `.Ticks`: the latter is 100ns since 0001 and would be read as
      // ~1600 years in the future. ToFileTimeUtc normalizes to UTC and the 1601 epoch, which is
      // what `parseFiletime` expects.
      const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.ToFileTimeUtc() }`
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20000, windowsHide: true })
      const startMs = parseFiletime(Number.parseFloat(stdout.trim()))
      return startMs === null ? null : { startMs, zombie: false }
    }
    catch {
      return null
    }
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'state=,lstart='], { timeout: 3000 })
    return parsePsBirth(stdout)
  }
  catch {
    return null
  }
}

/** Is the process at `pid` the one a record stamped `startedAt` describes? */
export type ProcessLiveness
  /** Alive, and born when the record implies. */
  = | 'live'
  /** Nothing is running behind the pid: absent, or a zombie nobody has reaped. */
    | 'gone'
  /** A live pid, but born *after* the record was written — the OS recycled it. */
    | 'recycled'
  /** The platform would not report a birth time, so the live pid is all there is to go on. */
    | 'unknown'

/**
 * A pid is **not** an identity. The OS hands a dead process's pid to an unrelated one later, and a
 * zombie — exited but not yet reaped by its parent — still answers signal 0. So `isProcessAlive`
 * alone can report a long-dead daemon as live, which is what let `up` say "already running" and
 * `status` say "running, but not answering" against a stale `run.json`, and what let `down` signal
 * whatever stranger had inherited the pid.
 *
 * `startedAt` settles it in one direction, with no threshold to guess at: the daemon writes its
 * record *during its own boot*, so its process is necessarily born **before** that stamp. A pid born
 * after it is not that process, whoever else it now is. The comparison is deliberately one-sided —
 * the other direction would have to tell a recycled pid from a wall clock that merely moved, and it
 * cannot, so a record is never called stale for being *older* than its process.
 *
 * `'unknown'` is not `'gone'`: a platform that cannot report a birth time must not have its live pid
 * dismissed, or a running panel's record would be cleared out from under it.
 */
export async function processLiveness(
  pid: number,
  startedAt: number,
  options: { toleranceMs?: number, readBirth?: (pid: number) => Promise<ProcessBirth | null> } = {},
): Promise<ProcessLiveness> {
  if (!isProcessAlive(pid))
    return 'gone'

  const birth = await (options.readBirth ?? processBirth)(pid)
  if (birth === null)
    return 'unknown'
  if (birth.zombie)
    return 'gone'

  // The tolerance absorbs the one-second granularity of `ps -o lstart=`, which can report a
  // process as born a fraction *after* `startedAt` even though it really started before it.
  return birth.startMs > startedAt + (options.toleranceMs ?? 2000) ? 'recycled' : 'live'
}

function signalPid(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name)
  }
  catch {
    // already gone, or not ours to signal
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Asks specific pids to leave, politely first: a stray dev server stops on
 * SIGTERM, and only what ignores it is killed. Deciding *which* pids may be
 * touched belongs to the caller — this only does the signalling.
 */
export async function terminatePids(
  pids: number[],
  options: { graceMs?: number } = {},
): Promise<{ stopped: number[], forced: number[] }> {
  const graceMs = options.graceMs ?? 3000
  const targets = [...new Set(pids)]
  // Only what was actually there is claimed as stopped; a pid that had already
  // exited is neither ours to report nor ours to kill.
  const aliveBefore = targets.filter(isProcessAlive)

  for (const pid of aliveBefore) signalPid(pid, 'SIGTERM')

  const deadline = Date.now() + graceMs
  let alive = aliveBefore.filter(isProcessAlive)
  while (alive.length > 0 && Date.now() < deadline) {
    await delay(100)
    alive = alive.filter(isProcessAlive)
  }

  const stopped = aliveBefore.filter(pid => !alive.includes(pid))
  for (const pid of alive) signalPid(pid, 'SIGKILL')
  if (alive.length > 0 && graceMs > 0)
    await delay(150)

  return { stopped, forced: alive }
}

/** `netstat -ano` lines: `  TCP    127.0.0.1:4010    0.0.0.0:0    LISTENING    1234` */
export function parseNetstatListeners(output: string, port: number): number[] {
  const pids = new Set<number>()

  for (const line of output.split(/\r?\n/)) {
    const cells = line.trim().split(/\s+/)
    if (cells.length < 5)
      continue
    const local = cells[1] ?? ''
    const state = cells[3] ?? ''
    const pid = Number.parseInt(cells[4] ?? '', 10)
    const localPort = Number.parseInt(local.slice(local.lastIndexOf(':') + 1), 10)
    if (state.toUpperCase() !== 'LISTENING' || localPort !== port)
      continue
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid)
      pids.add(pid)
  }

  return [...pids]
}

export async function listPortHolders(port: number): Promise<number[]> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], { timeout: 5000 })
      return parseNetstatListeners(stdout, port)
    }
    catch {
      return []
    }
  }

  try {
    const { stdout } = await execFileAsync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { timeout: 3000 })
    return parsePids(stdout)
  }
  catch {
    // lsof missing or nothing listening
  }

  try {
    const { stdout } = await execFileAsync('fuser', [`${port}/tcp`], { timeout: 3000 })
    return parsePids(stdout)
  }
  catch {
    return []
  }
}

/**
 * Pids from `lsof -ti` (one per line) or `fuser` (space-separated, on one line, with a leading
 * space) — both shapes arrive here, which is why the split is on `\s+` rather than `\n`.
 *
 * Exported for its test: this feeds `killPortHolders`, which sends SIGKILL, so a parser that
 * picked up the wrong number would kill an unrelated process. The filter is not decorative —
 * `Number.parseInt('')` is NaN for the empty leading cell, and a pid of 0 or our own is dropped.
 */
export function parsePids(stdout: string): number[] {
  return [...new Set(
    stdout.split(/\s+/)
      .map(entry => Number.parseInt(entry, 10))
      .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid),
  )]
}
