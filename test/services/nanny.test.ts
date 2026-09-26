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
  cleanups.push(() => fs.promises.rm(dir, { recursive: true, force: true }))
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

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined)
      return value
    if (Date.now() > deadline)
      throw new Error('waitFor timed out')
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
  cleanups.push(() => {
    try {
      process.kill(child.pid!, 'SIGKILL')
    }
    catch {
      // Already gone.
    }
  })
  return child.pid!
}

describe('nanny', () => {
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

    const grandPid = await waitFor(() => {
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
    await waitFor(() => readNannyState(statePath)?.lastExit !== undefined ? true : undefined)
    await waitFor(() => isAlive(nannyPid) ? undefined : true)
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

    await waitFor(() => linesOf(logFile).some(line => line.text === 'hello') ? true : undefined)
    await waitFor(() => linesOf(logFile).some(line => line.text === 'careful' && line.stream === 'stderr') ? true : undefined)
    // The spec holds expanded secrets, so it must not outlive the spawn that read it.
    await waitFor(() => fs.existsSync(specPath) ? undefined : true)

    const state = await waitFor(() => readNannyState(statePath) ?? undefined)
    expect(state.serverId).toBe('keep')
    expect(state.nannyPid).toBe(nannyPid)
    expect(state.childPid).not.toBeNull()
    expect(state.logFile).toBe(logFile)
    // The panel's own start line is written by the nanny, so a panel that attaches
    // later still sees why the entry came up.
    expect(linesOf(logFile).some(line => line.text.includes('runs this entry'))).toBe(true)

    // Stopping the nanny stops the entry, and leaves behind how it went.
    process.kill(nannyPid, 'SIGTERM')
    const exit = await waitFor(() => readNannyState(statePath)?.lastExit ?? undefined)
    expect(exit.signal).toBe('SIGTERM')
    expect(exit.runtimeMs).toBeGreaterThan(0)
    expect(linesOf(logFile).some(line => line.text.includes('exited with signal SIGTERM'))).toBe(true)
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

    const exit = await waitFor(() => readNannyState(statePath)?.lastExit ?? undefined)
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
