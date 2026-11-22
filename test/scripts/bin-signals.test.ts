import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { testPort } from '../support/ports'

/**
 * `bin/home-hosted.mjs` must forward a stop signal to the CLI it spawned.
 *
 * Node does not pass a signal to a child. A terminal's Ctrl-C reaches both because they share a process
 * group, but `kill <shim>` — what a supervisor, a container runtime or `systemctl stop` sends — hits
 * only the shim. Measured before the fix: `kill -TERM` on the shim exited 143 while the `up --foreground`
 * child kept running and holding its port, which for a panel is the worst shape there is.
 *
 * Real processes rather than a stub: the defect lives in the signal plumbing of `spawn`, so a mock
 * proves nothing. The child is `up --foreground` on its own `HHOSTED_HOME` and a port from the test
 * block, and every run cleans up in `finally`.
 */
const root = new URL('../..', import.meta.url).pathname
const bin = path.join(root, 'bin', 'home-hosted.mjs')

let home: string | null = null

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

/** Wait until `alive(pid)` matches, so the test never races the spawn or the shutdown. */
async function until(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate())
      return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${what}`)
}

let childPid: number | undefined

afterEach(async () => {
  /**
   * Kill the child **before** removing its home, and do it even when the assertion failed — otherwise a
   * red run leaves the exact orphan the test is about, holding a port from the shared test block. One
   * did, on :20000, while this test was being shown to fail without the fix.
   */
  if (childPid !== undefined && alive(childPid)) {
    try {
      process.kill(childPid, 'SIGKILL')
    }
    catch { /* already gone */ }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  childPid = undefined
  if (home !== null)
    fs.rmSync(home, { recursive: true, force: true })
  home = null
})

describe('the bin shim forwards a stop signal', () => {
  // POSIX signals only: `SIGTERM` on Windows is `TerminateProcess`, which the shim's handler never sees.
  it.runIf(process.platform !== 'win32')('stops the CLI it spawned when it is told to stop', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-bin-signal-'))
    // A real port from this worker's block: `--port 0` is refused by the CLI, and a child that exits
    // immediately makes the whole test vacuous — it "passed" without the fix for exactly that reason.
    const port = await testPort()
    const shim = spawn(process.execPath, [bin, 'up', '--foreground', '--port', String(port)], {
      cwd: root,
      env: { ...process.env, HHOSTED_HOME: home },
      stdio: 'ignore',
    })

    /**
     * Find the child **portably**. `/proc/<pid>/task/<pid>/children` is Linux-only and timed out on
     * macOS CI the first time this ran — the exact cross-platform mistake this repo has a rule against.
     * Argv is not a reliable handle either, because `up` rewrites its own (`--foreground` is added by the
     * command itself). So the child announces itself: the panel writes `run.json` with its pid once it is
     * listening, and that file is the panel's own contract with `down`.
     */
    await until(() => {
      try {
        const run = JSON.parse(fs.readFileSync(path.join(home!, '.hh', 'run.json'), 'utf8')) as { pid?: number }
        childPid = typeof run.pid === 'number' ? run.pid : undefined
        return childPid !== undefined && alive(childPid)
      }
      catch {
        return false
      }
    }, 'the panel to write run.json with its pid')
    expect(childPid, 'the shim must have a child before a signal means anything').toBeDefined()

    shim.kill('SIGTERM')
    await until(() => !alive(childPid!), 'the child to stop once the shim was told to', 25_000)
  }, 60_000)
})
