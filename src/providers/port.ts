import { execFile } from 'node:child_process'
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
 * Kills whatever holds the port. Only used as a last resort for wrappers that
 * spawn their real server detached, where a process-group signal cannot reach it.
 */
export async function killPortHolders(port: number): Promise<number[]> {
  const pids = await listPortHolders(port)
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

function parsePids(stdout: string): number[] {
  return [...new Set(
    stdout.split(/\s+/)
      .map(entry => Number.parseInt(entry, 10))
      .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid),
  )]
}
