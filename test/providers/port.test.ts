import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import net from 'node:net'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { isProcessAlive, killPortHolders, listPortHolders, terminatePids } from '#src/providers/port'

const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && isProcessAlive(child.pid))
      child.kill('SIGKILL')
  }
})

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * A real child process, which is the only thing a signal can be tested against.
 * It reports "ready" on stdout once its signal handler is installed — a signal
 * sent before then would race the runtime's own startup and prove nothing.
 */
function spawnSleeper(options: { ignoreTerm?: boolean } = {}): Promise<number> {
  const handler = options.ignoreTerm === true ? 'process.on("SIGTERM", () => {}); ' : ''
  const script = `${handler}process.stdout.write("ready\\n"); setInterval(() => {}, 1000)`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
  children.push(child)
  if (child.pid === undefined)
    throw new Error('could not spawn a helper process')
  const pid = child.pid

  return new Promise((resolve) => {
    child.stdout?.once('data', () => resolve(pid))
  })
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate())
      return
    await delay(25)
  }
  throw new Error('waitFor timed out')
}

/** A port the OS just handed out, and that nothing is listening on any more. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

describe('isProcessAlive', () => {
  it('reports a running child, and stops reporting it once it exits', async () => {
    const pid = await spawnSleeper()
    expect(isProcessAlive(pid)).toBe(true)

    process.kill(pid, 'SIGKILL')
    await waitFor(() => !isProcessAlive(pid))
    expect(isProcessAlive(pid)).toBe(false)
  })
})

describe('terminatePids', () => {
  it('stops a process on SIGTERM, without forcing it', async () => {
    const pid = await spawnSleeper()
    const result = await terminatePids([pid], { graceMs: 4000 })

    expect(result.stopped).toEqual([pid])
    expect(result.forced).toEqual([])
    expect(isProcessAlive(pid)).toBe(false)
  })

  // Windows turns every signal into an immediate terminate, so "ignores SIGTERM"
  // cannot be expressed there; the escalation itself is POSIX-only behaviour.
  it.runIf(process.platform !== 'win32')('kills what ignores SIGTERM', async () => {
    const pid = await spawnSleeper({ ignoreTerm: true })
    const result = await terminatePids([pid], { graceMs: 300 })

    expect(result.stopped).toEqual([])
    expect(result.forced).toEqual([pid])
    await waitFor(() => !isProcessAlive(pid))
  })

  it('claims nothing about a pid that is already gone', async () => {
    const pid = await spawnSleeper()
    process.kill(pid, 'SIGKILL')
    await waitFor(() => !isProcessAlive(pid))

    const result = await terminatePids([pid], { graceMs: 100 })
    expect(result.stopped).toEqual([])
    expect(result.forced).toEqual([])
  })

  it('deduplicates the pids it was given', async () => {
    const pid = await spawnSleeper()
    const result = await terminatePids([pid, pid], { graceMs: 4000 })

    expect(result.stopped).toEqual([pid])
    expect(result.forced).toEqual([])
  })
})

describe('killPortHolders', () => {
  it('never touches a listener it was told to exclude', async () => {
    const port = await freePort()
    const child = spawn(process.execPath, ['-e', `require("node:net").createServer().listen(${port}, "127.0.0.1")`], { stdio: 'ignore' })
    children.push(child)
    if (child.pid === undefined)
      throw new Error('could not spawn a listener')
    const pid = child.pid

    try {
      await waitFor(async () => (await listPortHolders(port)).includes(pid))

      // The panel's own process tree is never a leftover to kill: a sibling entry
      // under `onPortConflict: warn` shares a port without becoming a target.
      expect(await killPortHolders(port, new Set([pid]))).toEqual([])
      expect(isProcessAlive(pid)).toBe(true)

      expect(await killPortHolders(port)).toContain(pid)
      await waitFor(() => !isProcessAlive(pid))
    }
    finally {
      if (isProcessAlive(pid))
        process.kill(pid, 'SIGKILL')
    }
  })
})
