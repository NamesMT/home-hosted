import type { ChildProcess } from 'node:child_process'
import type { NannyState } from '#src/shared/contracts'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { nannyIsAlive, nannyStatePath, writeNannyState } from '#src/providers/nanny'
import { livePersistentEntries } from '#src/providers/nanny-sweep'
import { isProcessAlive } from '#src/providers/port'

/**
 * Is the process a state file names really the nanny it describes?
 *
 * A live pid proves nothing on its own: the OS reuses pids, and the nanny state file is written by
 * the process it describes, so a *recycled* pid plus a recent write reads as a running entry. Every
 * caller of this is destructive — `down --with-persistent` signals it, `resumePersistent` adopts it
 * as the entry's own process, `ProxyService.stop()` kills it.
 *
 * `startedAt` is the tiebreak, exactly as `run.json` uses it: the nanny stamps its own record during
 * its boot, so its process is necessarily born *before* that stamp. A pid born after it is a stranger
 * that inherited the number. Where the platform cannot report a birth time the live pid is all there
 * is, and that answer has to stay "alive" rather than guess.
 */

const children: ChildProcess[] = []
const homes: string[] = []

/** A platform whose process table can answer a birth time, decided once. */
const hasBirth = process.platform === 'linux' || process.platform === 'darwin'

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && isProcessAlive(child.pid))
      child.kill('SIGKILL')
  }
  for (const home of homes.splice(0))
    fs.rmSync(home, { recursive: true, force: true })
})

/** A real long-lived process to name in a record, and its pid. */
function spawnSleeper(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(child)
  if (child.pid === undefined)
    throw new Error('could not spawn a helper process')
  return child.pid
}

/** A `$HHOSTED_HOME` with one workspace's `.state` directory. */
function makeHome(): { hhDir: string, stateDir: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-nanny-'))
  homes.push(home)
  const hhDir = path.join(home, '.hh')
  const stateDir = path.join(hhDir, 'default', '.state')
  fs.mkdirSync(stateDir, { recursive: true })
  return { hhDir, stateDir }
}

function stateFor(pid: number, patch: Partial<NannyState> = {}): NannyState {
  return {
    serverId: 'keep',
    nannyPid: pid,
    childPid: null,
    startedAt: Date.now(),
    logFile: '',
    heartbeatAt: Date.now(),
    ...patch,
  } as NannyState
}

describe('nannyIsAlive', () => {
  it('does not accept a pid the OS recycled, however fresh the heartbeat', async () => {
    // The record is an hour old and names a pid that started a moment ago, with the heartbeat
    // refreshed — the shape a recycled pid leaves when a write happens to land after the reuse.
    const pid = spawnSleeper()
    const state = stateFor(pid, { startedAt: Date.now() - 3_600_000, heartbeatAt: Date.now() })

    expect(await nannyIsAlive(state, 'keep'), 'a recycled pid was adopted as the entry\'s own').toBe(false)
  })

  it.runIf(hasBirth)('accepts a nanny that really is the process the record names', async () => {
    // The record predates the process, which is the true ordering: the nanny writes its state
    // file during its own boot, so its birth time is before the stamp.
    const pid = spawnSleeper()
    const state = stateFor(pid, { startedAt: Date.now() + 60_000, heartbeatAt: Date.now() })

    expect(await nannyIsAlive(state, 'keep')).toBe(true)
  })

  it('keeps the safe answer where the platform cannot report a birth time', async () => {
    // No birth time is not "gone": guessing there would start a second copy of an entry that is
    // already running, which is the duplicate this whole check exists to prevent.
    const pid = spawnSleeper()
    const record = stateFor(pid, { startedAt: Date.now() - 3_600_000, heartbeatAt: Date.now() })

    const alive = await nannyIsAlive(record, 'keep', { readBirth: async () => null })
    expect(alive).toBe(true)
  })
})

describe('livePersistentEntries', () => {
  it('does not report an entry whose record is a recycled pid', async () => {
    const { hhDir, stateDir } = makeHome()
    const pid = spawnSleeper()
    // `down --with-persistent` signals whatever this returns, so a stranger here is a stranger
    // this CLI kills in the entry's name.
    writeNannyState(nannyStatePath(stateDir, 'keep'), stateFor(pid, { startedAt: Date.now() - 3_600_000 }))

    expect(await livePersistentEntries(hhDir)).toEqual([])
  })

  it.runIf(hasBirth)('still finds a nanny the record really describes', async () => {
    const { hhDir, stateDir } = makeHome()
    const pid = spawnSleeper()
    writeNannyState(nannyStatePath(stateDir, 'keep'), stateFor(pid, { startedAt: Date.now() + 60_000 }))

    const found = await livePersistentEntries(hhDir)
    expect(found.map(entry => entry.serverId)).toEqual(['keep'])
    expect(found[0]!.state.nannyPid).toBe(pid)
  })
})
