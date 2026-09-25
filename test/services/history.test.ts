import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HistoryStore } from '#src/services/history'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function makeHistory() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-history-'))
  dirs.push(dir)
  const file = path.join(dir, 'history.json')
  return { history: new HistoryStore(file), file }
}

const HOUR = 60 * 60 * 1000

describe('history store', () => {
  it('counts restarts, crashes and forced restarts inside the window', async () => {
    const { history } = await makeHistory()
    const now = Date.now()

    history.record('web', { type: 'start', detail: 'run' }, now - 3 * HOUR)
    history.record('web', { type: 'exit', detail: 'code 0', runtimeMs: 1 * HOUR }, now - 2 * HOUR)
    history.record('web', { type: 'start', detail: 'run' }, now - 2 * HOUR)
    history.record('web', { type: 'unhealthy', detail: 'port silent' }, now - 90 * 60 * 1000)
    history.record('web', { type: 'forced-restart', detail: 'port stayed unhealthy' }, now - 90 * 60 * 1000)
    history.record('web', { type: 'crash', detail: 'gave up', runtimeMs: 30 * 60 * 1000 }, now - 30 * 60 * 1000)

    const summary = history.summarize('web', 24 * HOUR, now)
    expect(summary.restarts).toBe(2)
    expect(summary.crashes).toBe(1)
    expect(summary.forcedRestarts).toBe(1)
    expect(summary.lastCrashAt).toBe(now - 30 * 60 * 1000)
    expect(summary.lastRuntimeMs).toBe(30 * 60 * 1000)
    expect(summary.events.length).toBe(6)
  })

  it('ignores events from other servers and outside the window', async () => {
    const { history } = await makeHistory()
    const now = Date.now()

    history.record('web', { type: 'start', detail: 'run' }, now - 100 * HOUR)
    history.record('web', { type: 'crash', detail: 'old', runtimeMs: 1000 }, now - 100 * HOUR)
    history.record('api', { type: 'crash', detail: 'other server', runtimeMs: 1000 }, now)

    const summary = history.summarize('web', 24 * HOUR, now)
    expect(summary.crashes).toBe(0)
    expect(summary.restarts).toBe(0)
    expect(summary.lastCrashAt).toBe(now - 100 * HOUR)
  })

  it('derives uptime from recorded runtimes plus the in-flight interval', async () => {
    const { history } = await makeHistory()
    const now = Date.now()

    // 6h up, then 18h of downtime, then running for 2h.
    history.record('web', { type: 'start', detail: 'run' }, now - 20 * HOUR)
    history.record('web', { type: 'exit', detail: 'code 0', runtimeMs: 6 * HOUR }, now - 14 * HOUR)
    history.record('web', { type: 'start', detail: 'run' }, now - 2 * HOUR)

    const summary = history.summarize('web', 24 * HOUR, now, now - 2 * HOUR)
    expect(summary.uptimeRatio).toBeCloseTo(8 / 24, 2)
  })

  it('reports uptime as unknown before anything is recorded', async () => {
    const { history } = await makeHistory()
    expect(history.summarize('web', 24 * HOUR).uptimeRatio).toBeNull()
  })

  it('does not exceed 100 percent when runtimes overlap the window', async () => {
    const { history } = await makeHistory()
    const now = Date.now()
    history.record('web', { type: 'exit', detail: 'code 0', runtimeMs: 40 * HOUR }, now - HOUR)
    expect(history.summarize('web', 24 * HOUR, now).uptimeRatio).toBe(1)
  })

  it('persists across instances and flushes on dispose', async () => {
    const { history, file } = await makeHistory()
    history.record('web', { type: 'crash', detail: 'boom', runtimeMs: 1000 })
    history.dispose()

    expect(fs.existsSync(file)).toBe(true)
    const reloaded = new HistoryStore(file)
    expect(reloaded.summarize('web', 24 * HOUR).crashes).toBe(1)
  })

  it('survives a corrupt file', async () => {
    const { history, file } = await makeHistory()
    await fs.promises.writeFile(file, '{ not json')

    const fresh = new HistoryStore(file)
    expect(fresh.summarize('web', 24 * HOUR).crashes).toBe(0)
    expect(history.all()).toEqual([])
  })
})
