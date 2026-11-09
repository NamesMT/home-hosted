import type { StopConfig } from '#src/shared/contracts'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { stopPersistentEntries } from '#src/providers/nanny-sweep'

/**
 * Whether the entry's own server gets a direct signal, which depends on what the nanny can
 * be told.
 *
 * The nanny traps a fixed set of signals and forwards the entry's `stop` policy to the child it
 * owns. A signal outside that set kills the nanny outright, so nothing was forwarded — and with
 * `killGroup: false` the group signal never reached the child either. The pid in the state file
 * is then the only handle on a server that is still serving.
 *
 * The terminator is the seam, so every case here is deterministic and platform-independent:
 * what is asserted is *which pid was signalled with what*, which is the decision.
 */

/** A pid the OS has already reaped, so `isProcessAlive` answers false for it everywhere. */
function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })
    const pid = child.pid!
    child.once('exit', () => resolve(pid))
  })
}

interface Call {
  pid: number
  signal: string
  killGroup: boolean
}

async function stopWith(policy: StopConfig, nannyOutcome: 'exited' | 'force-killed'): Promise<{ calls: Call[], nannyPid: number, childPid: number }> {
  // Two distinct reaped pids: the kernel reuses them immediately, and the assertion below is
  // about *which* one was signalled.
  const nannyPid = await deadPid()
  let childPid = await deadPid()
  while (childPid === nannyPid) childPid = await deadPid()

  const calls: Call[] = []

  const results = await stopPersistentEntries([{
    workspaceId: 'default',
    serverId: 'keep',
    dir: process.cwd(),
    state: {
      serverId: 'keep',
      nannyPid,
      childPid,
      startedAt: Date.now(),
      logFile: '',
      heartbeatAt: Date.now(),
    },
  }], {
    stopFor: () => policy,
    terminate: async (pid, options) => {
      calls.push({ pid, signal: options.signal, killGroup: options.killGroup })
      return pid === nannyPid ? nannyOutcome : 'exited'
    },
    // Reaped pids stand in for a live child here; whether it is still *that* child is its own test.
    childPid: async state => state.childPid,
  })

  expect(results[0]!.stopped).toBe(true)
  return { calls, nannyPid, childPid }
}

const base: StopConfig = { signal: 'SIGTERM', killGroup: false, graceMs: 5000, killPortHolders: false }

describe('stopping a persistent entry', () => {
  it('stops the entry’s own server when the configured signal cannot be trapped', async () => {
    // `SIGKILL` is a selectable stop policy. The nanny dies without forwarding anything, so the
    // child is left running — while this reported the entry stopped and deleted its record.
    const { calls, nannyPid, childPid } = await stopWith({ ...base, signal: 'SIGKILL' }, 'exited')

    expect(calls.map(call => call.pid)).toEqual([nannyPid, childPid])
    expect(calls[1]).toEqual({ pid: childPid, signal: 'SIGKILL', killGroup: false })
  })

  it('leaves the child to finish its own shutdown when the nanny did forward the stop', async () => {
    // The nanny exits only after its child does, so a graceful exit means the shutdown already
    // happened — signalling the pid again would cut it short.
    const { calls, nannyPid } = await stopWith(base, 'exited')

    expect(calls.map(call => call.pid)).toEqual([nannyPid])
  })

  it('stops the child when the nanny had to be force-killed', async () => {
    // A nanny killed through its grace period may have died mid-shutdown, leaving the child.
    const { calls, childPid } = await stopWith({ ...base, signal: 'SIGINT' }, 'force-killed')

    expect(calls.map(call => call.pid)).toEqual([calls[0]!.pid, childPid])
    expect(calls[1]!.signal).toBe('SIGKILL')
  })

  it('leaves both to the process group when the stop signals the group', async () => {
    // `killGroup: true` signals the nanny's group, which the child shares — nothing is orphaned.
    const { calls } = await stopWith({ ...base, signal: 'SIGKILL', killGroup: true }, 'exited')

    expect(calls).toHaveLength(1)
  })
})

/**
 * The child pid is signalled after its nanny is gone, so it may already be somebody else's: pids are
 * recycled. Only a process born when the nanny stamped its record is that child.
 */
describe('stopping the child a nanny could not reach', () => {
  async function signalledPids(startedAt: number): Promise<{ calls: number[], live: number }> {
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    const exited = new Promise(resolve => live.once('exit', resolve))
    try {
      // Let it be born before the stamp the caller chose.
      await new Promise(resolve => setTimeout(resolve, 100))
      const nannyPid = await deadPid()
      const calls: number[] = []
      await stopPersistentEntries([{
        workspaceId: 'default',
        serverId: 'keep',
        dir: process.cwd(),
        state: { serverId: 'keep', nannyPid, childPid: live.pid!, startedAt: startedAt === 0 ? Date.now() : startedAt, logFile: '', heartbeatAt: Date.now() },
      }], {
        stopFor: () => ({ ...base, signal: 'SIGKILL' }),
        terminate: async (pid) => {
          calls.push(pid)
          return 'exited'
        },
      })
      return { calls: calls.filter(pid => pid !== nannyPid), live: live.pid! }
    }
    finally {
      live.kill('SIGKILL')
      await exited
    }
  }

  it('leaves a pid born after the nanny\'s record alone', async () => {
    const { calls } = await signalledPids(Date.now() - 60_000)
    expect(calls).toEqual([])
  })

  it('stops the pid when it is the child the record describes', async () => {
    const { calls, live } = await signalledPids(0)
    expect(calls).toEqual([live])
  })
})
