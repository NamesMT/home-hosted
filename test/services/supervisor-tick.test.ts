import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { entryStatePath, writeEntryState } from '#src/providers/entry-state'
import { scanOrphans } from '#src/services/supervisor/records'
import { makeSupervisor, runCleanups, scratchDir, view, waitFor } from '../support/supervisor-harness'

afterEach(runCleanups)

/**
 * The once-a-second tick. It awaited every force or memory restart inline (a stop grace of up to
 * several seconds) and had no in-flight guard, so ticks piled up behind one slow stop while every
 * other entry's probes waited — and the orphan scan re-read each orphan's birth (a `ps`, or a
 * PowerShell call on Windows) every second.
 */
describe('the supervisor tick', () => {
  it('never runs two ticks at once', async () => {
    const { supervisor } = await makeSupervisor([])
    let running = 0
    let most = 0
    vi.spyOn(supervisor as unknown as { refreshOrphans: () => Promise<void> }, 'refreshOrphans').mockImplementation(async () => {
      running += 1
      most = Math.max(most, running)
      await new Promise(resolve => setTimeout(resolve, 2500))
      running -= 1
    })
    await new Promise(resolve => setTimeout(resolve, 4000))
    expect(most).toBe(1)
  })

  it('keeps ticking while a memory restart waits out a slow stop', async () => {
    const harness = await makeSupervisor([{
      id: 'hog',
      command: process.execPath,
      // Ignores SIGTERM, so the restart's stop takes its whole grace period.
      args: ['-e', 'process.on("SIGTERM", () => {}); const hold = []; for (let i = 0; i < 64; i++) hold.push(Buffer.alloc(1024 * 1024, i)); setInterval(() => {}, 1000)'],
      health: { enabled: false },
      resources: { maxRssBytes: 8 * 1024 * 1024 },
      stop: { graceMs: 5000 },
      restart: { maxRetries: 3, baseDelayMs: 50, factor: 2, maxDelayMs: 200, resetAfterMs: 60000 },
    }])
    await harness.supervisor.start('hog')
    await waitFor(() => harness.supervisor.logLines('hog').some(line => line.text.includes('over the') && line.text.includes('restarting')), 30000)
    await waitFor(() => view(harness.supervisor, 'hog').status === 'stopping', 5000)

    const before = harness.stateChanges()
    await new Promise(resolve => setTimeout(resolve, 3000))
    expect(view(harness.supervisor, 'hog').status, 'the stop is still in its grace period').toBe('stopping')
    expect(harness.stateChanges() - before, 'ticks keep publishing during the stop').toBeGreaterThanOrEqual(2)
  })
})

describe('scanOrphans', () => {
  it('reads an orphan\'s birth once per recheck window, not on every scan', async () => {
    const dir = await scratchDir('hh-orphans-')
    // This test process stands in for the orphan: alive, and born before the stamp.
    const startedAt = Date.now()
    const pid = process.ppid
    writeEntryState(entryStatePath(dir, 'gone-entry'), { restarts: 0, healthRestarts: 0, bootstrapDone: true, pendingLoad: null, lastPid: pid, lastStartedAt: startedAt })
    expect(fs.existsSync(path.join(dir, 'gone-entry.run.json'))).toBe(true)

    const cache = new Map()
    const readBirth = vi.fn(async () => ({ startMs: startedAt - 60_000, zombie: false }))
    const now = Date.now()
    for (let i = 0; i < 5; i++)
      expect(await scanOrphans(dir, () => false, { cache, now: now + i * 1000, readBirth })).toHaveLength(1)
    expect(readBirth).toHaveBeenCalledTimes(1)

    await scanOrphans(dir, () => false, { cache, now: now + 20_000, readBirth })
    expect(readBirth).toHaveBeenCalledTimes(2)
  })
})
