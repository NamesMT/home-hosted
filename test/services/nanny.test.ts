import type { NannySpec } from '#src/shared/contracts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  nannyLogFile,
  nannySpecPath,
  nannyStatePath,
  readNannyState,
  sweepNannySpecs,
  takeNannySpec,
  writeNannySpec,
} from '#src/providers/nanny'

/**
 * The nanny end to end, through the real CLI: it is the one process that has to keep
 * working when the panel does not, so its protocol (JSONL out, state file, mirrored
 * exit) is pinned here rather than mocked.
 */

const CLI_ENTRY = fileURLToPath(new URL('../../src/cli.ts', import.meta.url))

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-nanny-'))
  // `maxRetries` is what makes this work on Windows, where removing a directory fails
  // while any process still has it open.
  cleanups.push(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  return dir
}

function baseSpec(dir: string): NannySpec {
  return {
    serverId: 'keep',
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: dir,
    env: {},
    logDir: path.join(dir, 'logs'),
    logs: { persist: true, maxBytes: 1_000_000, keep: 3 },
    stop: { signal: 'SIGTERM', killGroup: false, graceMs: 2000, killPortHolders: false },
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

/**
 * A budget deliberately below the global 30s test timeout. Set equal to it, vitest always
 * wins the race and the failure reads "Test timed out in 30000ms" with no cause; below it,
 * this throws its own error naming what never happened.
 */
async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined)
      return value
    if (Date.now() > deadline)
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${what}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

function linesOf(file: string): Array<{ stream: string, text: string }> {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as { stream: string, text: string })
  }
  catch {
    return []
  }
}

/** Runs one nanny through tsx, the same way the panel runs the compiled CLI. */
async function startNanny(spec: NannySpec, specPath: string, statePath: string): Promise<number> {
  const { spawn } = await import('node:child_process')
  writeNannySpec(specPath, spec)
  const child = spawn(process.execPath, [
    '--import',
    import.meta.resolve('tsx'),
    CLI_ENTRY,
    '__nanny',
    '--id',
    spec.serverId,
    '--spec',
    specPath,
    '--state',
    statePath,
  ], { stdio: 'ignore' })
  child.unref()
  cleanups.push(async () => {
    // The nanny runs its child with `cwd` inside the temp directory, and Windows refuses
    // to remove a directory a live process still sits in — as well as the log file it
    // holds open. So both pids are killed and waited on before the directory goes.
    const state = readNannyState(statePath)
    const pids = [child.pid, state?.childPid].filter((pid): pid is number => typeof pid === 'number')
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      }
      catch {
        // Already gone.
      }
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && pids.some(pid => isAlive(pid)))
      await new Promise(resolve => setTimeout(resolve, 50))
  })
  return child.pid!
}

describe('nanny', () => {
  /**
   * The signal traps must be up before the child exists, and the block between them must stay
   * synchronous.
   *
   * `runNanny` installs its SIGTERM/SIGINT handlers, then spawns. The `pending` slot exists for a
   * signal landing in between — but nothing in that block awaits, and Node delivers a signal handler
   * only *between* synchronous runs, so `spawned` is always already set by the time a handler runs.
   * Both halves measured: a handler raised during a busy-loop never ran until the loop yielded, and
   * an instrumented `onSignal` on the real nanny always printed `spawned=set`.
   *
   * So this pins the *ordering* rather than the `pending` branch, because the branch is unreachable
   * while the ordering holds — and it is the ordering that keeps it that way. Add an `await` before
   * `spawnManaged` and this fails, which is the moment `pending` becomes live code.
   */
  it('installs its traps before spawning, with no await in between', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('../../src/services/nanny.ts', import.meta.url)), 'utf8')
    const traps = source.indexOf('process.on(\'SIGTERM\'')
    const spawn = source.indexOf('spawnManaged(')
    expect(traps, 'the SIGTERM trap must be installed').toBeGreaterThan(-1)
    expect(spawn, 'the spawn must be there').toBeGreaterThan(-1)
    expect(traps, 'traps before the child exists').toBeLessThan(spawn)

    // The window between the last trap and the spawn assignment must contain no `await`: an await
    // there is a tick, and a tick is where a signal handler runs.
    const window = source.slice(traps, source.indexOf('spawned = child'))
    expect(window, 'no await between the traps and the spawn').not.toMatch(/\bawait\b/)
  })

  it('exits with its child, even when a successor kept its pipes open', async () => {
    // The pattern `follow` exists for: a program restarts itself by spawning a detached
    // successor with inherited stdio and exiting. That successor holds the write end of
    // this nanny's pipes, which is a handle the event loop would wait on — so a nanny
    // that does not exit explicitly lingers, and the panel then reports a healthy entry
    // while the process doing the work is a detached stranger.
    const dir = await tempDir()
    const logDir = path.join(dir, 'logs')
    const specPath = path.join(dir, 'keep.spec.json')
    const statePath = path.join(dir, 'keep.json')
    const grandPidFile = path.join(dir, 'grand.pid')

    const childScript = path.join(dir, 'child.cjs')
    fs.writeFileSync(childScript, [
      'const fs = require(\'node:fs\')',
      'const { spawn } = require(\'node:child_process\')',
      `const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'inherit' })`,
      'g.unref()',
      `fs.writeFileSync(${JSON.stringify(grandPidFile)}, String(g.pid))`,
      'console.log(\'child: successor spawned, exiting\')',
      'process.exit(0)',
    ].join('\n'))

    const nannyPid = await startNanny({
      serverId: 'keep',
      command: process.execPath,
      args: [childScript],
      cwd: dir,
      env: {},
      logDir,
      logs: { persist: true, maxBytes: 1_000_000, keep: 3 },
      stop: { signal: 'SIGTERM', killGroup: false, graceMs: 2000, killPortHolders: false },
    }, specPath, statePath)

    const grandPid = await waitFor('the successor to write its pid file', () => {
      try {
        return Number.parseInt(fs.readFileSync(grandPidFile, 'utf8'), 10)
      }
      catch {
        return undefined
      }
    })
    cleanups.push(() => {
      try {
        process.kill(grandPid, 'SIGKILL')
      }
      catch {
        // Already gone.
      }
    })

    // The child is gone, so the nanny must be too — the successor it left behind is a
    // different process, with its own pipes, and is not this nanny's to hold open.
    await waitFor('the nanny to record its last exit', () => readNannyState(statePath)?.lastExit !== undefined ? true : undefined)
    await waitFor('the nanny process to exit', () => isAlive(nannyPid) ? undefined : true)
    expect(isAlive(grandPid)).toBe(true)
  })

  it('consumes a spec it cannot parse, so no secret file is left behind', async () => {
    const dir = await tempDir()
    const specPath = nannySpecPath(dir, 'keep')
    fs.writeFileSync(specPath, '{"serverId":"keep","command":1}')

    expect(() => takeNannySpec(specPath)).toThrow()
    expect(fs.existsSync(specPath)).toBe(false)
  })

  it('sweeps every spec a nanny never read', async () => {
    const dir = await tempDir()
    writeNannySpec(nannySpecPath(dir, 'one'), { ...baseSpec(dir), serverId: 'one' })
    writeNannySpec(nannySpecPath(dir, 'two'), { ...baseSpec(dir), serverId: 'two' })
    fs.writeFileSync(nannyStatePath(dir, 'one'), '{}')

    expect(sweepNannySpecs(dir)).toBe(2)
    // State files belong to nannies that may still be running: never swept.
    expect(fs.existsSync(nannyStatePath(dir, 'one'))).toBe(true)
  })

  it('runs the entry, writes its output as JSONL and records how it ended', async () => {
    const dir = await tempDir()
    const logDir = path.join(dir, 'logs')
    const specPath = path.join(dir, 'keep.spec.json')
    const statePath = path.join(dir, 'keep.json')
    const logFile = nannyLogFile(logDir, 'keep')

    const nannyPid = await startNanny({
      serverId: 'keep',
      command: process.execPath,
      args: ['-e', 'console.log("hello"); console.error("careful"); setInterval(() => {}, 1000)'],
      cwd: dir,
      env: {},
      logDir,
      logs: { persist: true, maxBytes: 1_000_000, keep: 3 },
      stop: { signal: 'SIGTERM', killGroup: false, graceMs: 2000, killPortHolders: false },
    }, specPath, statePath)

    await waitFor('the child\'s stdout to reach the log', () => linesOf(logFile).some(line => line.text === 'hello') ? true : undefined)
    await waitFor('the child\'s stderr to reach the log', () => linesOf(logFile).some(line => line.text === 'careful' && line.stream === 'stderr') ? true : undefined)
    // The spec holds expanded secrets, so it must not outlive the spawn that read it.
    await waitFor('the spawn spec to be consumed and swept', () => fs.existsSync(specPath) ? undefined : true)

    const state = await waitFor('the nanny state file to appear', () => readNannyState(statePath) ?? undefined)
    expect(state.serverId).toBe('keep')
    expect(state.nannyPid).toBe(nannyPid)
    expect(state.childPid).not.toBeNull()
    expect(state.logFile).toBe(logFile)
    // The panel's own start line is written by the nanny, so a panel that attaches
    // later still sees why the entry came up.
    expect(linesOf(logFile).some(line => line.text.includes('runs this entry'))).toBe(true)
  })

  // Windows has no signals to trap: `process.kill(pid, 'SIGTERM')` is a hard terminate
  // there, so a nanny can never write down how it was stopped. The panel's Windows stop
  // is a tree kill, which is what `killTreeWindows` already does for every entry.
  it.runIf(process.platform !== 'win32')('takes its child down on SIGTERM and records how it went', async () => {
    const dir = await tempDir()
    const logDir = path.join(dir, 'logs')
    const specPath = path.join(dir, 'keep.spec.json')
    const statePath = path.join(dir, 'keep.json')
    const logFile = nannyLogFile(logDir, 'keep')

    const nannyPid = await startNanny({
      ...baseSpec(dir),
      args: ['-e', 'setInterval(() => {}, 1000)'],
    }, specPath, statePath)

    const state = await waitFor('the nanny state file to appear', () => readNannyState(statePath) ?? undefined)
    const childPid = state.childPid
    if (childPid === null)
      throw new Error('the nanny recorded no child')

    process.kill(nannyPid, 'SIGTERM')

    const exit = await waitFor('the nanny to record an exit', () => readNannyState(statePath)?.lastExit ?? undefined)
    expect(exit.signal).toBe('SIGTERM')
    // Not `toBeGreaterThan(0)`: `runtimeMs` is `Date.now() - startedAt`, and the child here is
    // killed the moment its state file appears, so on a fast machine it exits inside the same
    // millisecond — a legitimate 0. Asserting on that tests the clock's resolution, not the
    // nanny. What must hold is that a runtime was recorded at all, and that it is not nonsense.
    expect(Number.isFinite(exit.runtimeMs)).toBe(true)
    expect(exit.runtimeMs).toBeGreaterThanOrEqual(0)

    // Waited for, not read once. `finish()` emits this line into the log's pending buffer,
    // *then* writes `lastExit` to the state file, *then* disposes — which is what flushes. So
    // the instant `lastExit` is visible the log line may still be in memory, and a single read
    // races that flush. It passed six times locally and failed on a loaded macOS runner. The
    // sibling test above waits for its lines the same way, for the same reason.
    await waitFor('the nanny to log how it exited', () =>
      linesOf(logFile).some(line => line.text.includes('exited with signal SIGTERM')) ? true : undefined)
    await waitFor('the child process to exit', () => isAlive(childPid) ? undefined : true)
    await waitFor('the nanny process to exit', () => isAlive(nannyPid) ? undefined : true)
  })

  it.runIf(process.platform !== 'win32')('never leaves a child behind when the stop beats the spawn', async () => {
    // The panel signals a nanny as soon as it has its pid, which can be before the nanny
    // has spawned anything. Whatever the signal lands on — the module load, the spawn, or
    // the moment the state file appears — a child the nanny recorded has to be a child it
    // took down, because that state file is the only record the panel would have of it.
    const dir = await tempDir()
    const specPath = path.join(dir, 'keep.spec.json')
    const statePath = path.join(dir, 'keep.json')

    const nannyPid = await startNanny(baseSpec(dir), specPath, statePath)
    process.kill(nannyPid, 'SIGTERM')

    await waitFor('the nanny process to exit', () => isAlive(nannyPid) ? undefined : true)
    const state = readNannyState(statePath)
    if (state?.childPid != null) {
      expect(state.lastExit?.signal).toBe('SIGTERM')
      await waitFor('the adopted child to exit', () => isAlive(state.childPid!) ? undefined : true)
    }
  })

  it('reports an entry that cannot be started instead of hanging', async () => {
    const dir = await tempDir()
    const logDir = path.join(dir, 'logs')
    const specPath = path.join(dir, 'broken.spec.json')
    const statePath = path.join(dir, 'broken.json')

    await startNanny({
      serverId: 'broken',
      command: path.join(dir, 'does-not-exist'),
      args: [],
      cwd: dir,
      env: {},
      logDir,
      logs: { persist: true, maxBytes: 1_000_000, keep: 3 },
      stop: { signal: 'SIGTERM', killGroup: false, graceMs: 2000, killPortHolders: false },
    }, specPath, statePath)

    const exit = await waitFor('the nanny to record an exit', () => readNannyState(statePath)?.lastExit ?? undefined)
    // Both null is the panel's "never got off the ground".
    expect(exit.code).toBeNull()
    expect(exit.signal).toBeNull()
  })

  it('refuses a spec that belongs to another entry', async () => {
    const dir = await tempDir()
    const specPath = path.join(dir, 'other.spec.json')
    writeNannySpec(specPath, {
      serverId: 'other',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: dir,
      env: {},
      logDir: path.join(dir, 'logs'),
      logs: { persist: true, maxBytes: 1_000_000, keep: 3 },
      stop: { signal: 'SIGTERM', killGroup: false, graceMs: 2000, killPortHolders: false },
    })

    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [
      '--import',
      import.meta.resolve('tsx'),
      CLI_ENTRY,
      '__nanny',
      '--id',
      'keep',
      '--spec',
      specPath,
      '--state',
      path.join(dir, 'keep.json'),
    ], { stdio: 'ignore' })

    const code = await new Promise<number | null>(resolve => child.once('exit', value => resolve(value)))
    expect(code).not.toBe(0)
  })
})
