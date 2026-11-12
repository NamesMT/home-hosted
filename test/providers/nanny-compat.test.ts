import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nannySpecPath, readNannyState, takeNannySpec } from '#src/providers/nanny'

/**
 * A nanny's files cross panel versions: a panel upgraded under a running nanny reads that nanny's
 * state, and an older panel still running reads a newer nanny's. A key one side does not know must
 * not make the record unreadable — an unreadable state reads as "no nanny", and the panel would
 * spawn a twin beside the one that is still running.
 */
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-nanny-compat-'))
  dirs.push(dir)
  return dir
}

describe('nanny files from another release', () => {
  it('reads a state file carrying keys this release does not know, at every level', () => {
    const file = path.join(tempDir(), 'keep.json')
    fs.writeFileSync(file, JSON.stringify({
      serverId: 'keep',
      nannyPid: 4242,
      childPid: 4243,
      startedAt: 1,
      logFile: '/tmp/keep.log',
      heartbeatAt: 2,
      fromTheFuture: true,
      lastExit: { code: 0, signal: null, at: 3, runtimeMs: 4, cause: 'newer' },
    }))

    const state = readNannyState(file)
    expect(state?.nannyPid).toBe(4242)
    expect(state?.lastExit?.code).toBe(0)
  })

  it('reads a spec carrying keys this release does not know, at every level', () => {
    const file = nannySpecPath(tempDir(), 'keep')
    fs.writeFileSync(file, JSON.stringify({
      serverId: 'keep',
      command: 'node',
      args: [],
      cwd: '/tmp',
      env: {},
      logDir: '/tmp/logs',
      logs: { persist: true, maxBytes: 1_000_000, keep: 3, fromTheFuture: 1 },
      stop: { signal: 'SIGTERM', killGroup: false, graceMs: 2000, killPortHolders: false, fromTheFuture: 1 },
      fromTheFuture: 1,
    }))

    expect(takeNannySpec(file).serverId).toBe('keep')
  })

  it('still refuses a state file that is wrong rather than newer', () => {
    const file = path.join(tempDir(), 'keep.json')
    fs.writeFileSync(file, JSON.stringify({ serverId: 'keep', nannyPid: 'not a pid' }))
    expect(readNannyState(file)).toBeNull()
  })
})
