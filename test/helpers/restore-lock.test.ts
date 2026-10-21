import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireRestoreLock, processBirthSync } from '#src/helpers/restore-lock'

/**
 * Two restores writing the same host interleave and replace each other's files, and nothing stopped
 * the panel's own restore from racing one started in a shell. The lock is one file both paths take.
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-lock-'))
  dirs.push(dir)
  return dir
}

describe('the restore lock', () => {
  it('is taken, then refuses a second caller while the first holds it', () => {
    const dir = makeDir()
    const first = acquireRestoreLock(dir)
    expect('heldBy' in first).toBe(false)

    const second = acquireRestoreLock(dir)
    expect('heldBy' in second, 'a live holder must block').toBe(true)
    if ('heldBy' in second)
      expect(second.heldBy.pid).toBe(process.pid)

    if (!('heldBy' in first))
      first.release()
  })

  it('is free again after a release', () => {
    const dir = makeDir()
    const first = acquireRestoreLock(dir)
    if ('heldBy' in first)
      throw new Error('the first acquisition must succeed')
    first.release()
    // Releasing twice must not throw; the finally block may run it after a failure.
    expect(() => first.release()).not.toThrow()

    const again = acquireRestoreLock(dir)
    expect('heldBy' in again).toBe(false)
    if (!('heldBy' in again))
      again.release()
  })

  /**
   * A lock taken a while ago by a process that is *still* holding it must stay held.
   *
   * `startedAt` is when the lock was taken; the holder's own birth necessarily precedes it. The first
   * version compared the two as "close together", so a lock older than five seconds looked recycled
   * and a second restore stole it — two restores on one host, which is the defect this exists for.
   * The holder here is a real child process, and its record is older than that tolerance.
   */
  it('keeps the lock for a live holder whose record is older than the birth tolerance', async () => {
    const dir = makeDir()
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true })
    child.unref()
    const pid = child.pid!
    try {
      // Older than the 5s tolerance the first version used, younger than the 30-minute stale window.
      // `birthAt` is what the child actually is, which is what a real holder records.
      fs.writeFileSync(path.join(dir, 'restore.lock'), `${JSON.stringify({ pid, startedAt: Date.now() - 10_000, action: 'restore', birthAt: processBirthSync(pid) })}\n`)
      const second = acquireRestoreLock(dir)
      const held = 'heldBy' in second
      // Linux can compare birth times, so a live holder keeps it. Elsewhere the birth is unknown and
      // the cautious answer is the same; either way this must not be taken over.
      expect(held, 'a live holder keeps its lock however long it has been holding it').toBe(true)
      if (!held)
        second.release()
    }
    finally {
      try {
        process.kill(pid, 'SIGKILL')
      }
      catch {}
    }
  })

  it('takes over a lock whose holder is gone', () => {
    const dir = makeDir()
    // A died process's pid. Chosen high and unused, with a birth time that cannot match.
    fs.writeFileSync(path.join(dir, 'restore.lock'), `${JSON.stringify({ pid: 4_194_303, startedAt: Date.now(), action: 'restore' })}\n`)

    const taken = acquireRestoreLock(dir)
    expect('heldBy' in taken, 'a dead holder must not keep the lock forever').toBe(false)
    if (!('heldBy' in taken)) {
      expect(taken.replaced?.pid).toBe(4_194_303)
      taken.release()
    }
  })

  it('does not trust a recycled pid whose birth time differs', async () => {
    const dir = makeDir()
    // A live child, but the record claims it started hours earlier: the pid was recycled.
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true })
    child.unref()
    const pid = child.pid!
    try {
      fs.writeFileSync(path.join(dir, 'restore.lock'), `${JSON.stringify({ pid, startedAt: Date.now() - 3_600_000, action: 'restore' })}\n`)
      const taken = acquireRestoreLock(dir)
      // Linux only answers a birth time; elsewhere the cautious answer keeps the lock, which is
      // why this asserts per platform rather than always taking over.
      if (process.platform === 'linux')
        expect('heldBy' in taken, 'a recycled pid is not the holder').toBe(false)
      else
        expect('heldBy' in taken).toBe(true)
      if (!('heldBy' in taken))
        taken.release()
    }
    finally {
      try {
        process.kill(pid, 'SIGKILL')
      }
      catch {}
    }
  })
})
