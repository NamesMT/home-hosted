import type { ChildProcess } from 'node:child_process'
import type { Entry } from '#src/services/supervisor/entry'
import type { HealthContext } from '#src/services/supervisor/health'
import { describe, expect, it, vi } from 'vitest'

// The port never answers, so the readiness wait always runs out.
vi.mock('#src/services/supervisor/port-preflight', async (importOriginal) => {
  const original = await importOriginal<typeof import('#src/services/supervisor/port-preflight')>()
  return { ...original, portAccepts: async () => false }
})

const { awaitReadiness, healthBudgetSpent, shouldForceRestart } = await import('#src/services/supervisor/health')

function makeEntry(enabled: boolean, child: ChildProcess): Entry {
  return {
    config: {
      id: 'web',
      port: 45601,
      health: { enabled, mode: 'tcp', timeoutMs: 50, startTimeoutMs: 30, unhealthyThreshold: 3, forceRestartAfterMs: 1000 },
      restart: { enabled: true, maxRetries: 0 },
    },
    child,
    status: 'starting',
    health: enabled ? 'unknown' : 'disabled',
    healthFailures: 0,
    unhealthySince: null,
    healthRestarts: 0,
    runToken: 0,
  } as unknown as Entry
}

function makeCtx(): { ctx: HealthContext, notified: string[], recorded: string[] } {
  const notified: string[] = []
  const recorded: string[] = []
  const ctx = {
    options: { history: { record: (_id: string, event: { type: string }) => recorded.push(event.type) } },
    log: () => {},
    publishServer: () => {},
    persist: () => {},
    notify: (_entry: Entry, reason: string) => notified.push(reason),
    isDisposed: () => false,
  } as unknown as HealthContext
  return { ctx, notified, recorded }
}

describe('a start that never answers on its port', () => {
  it('is an unhealthy streak like the probe’s: history event and notification included', async () => {
    const child = {} as ChildProcess
    const entry = makeEntry(true, child)
    const { ctx, notified, recorded } = makeCtx()
    await awaitReadiness(ctx, entry, child)

    expect(entry.status).toBe('running')
    expect(entry.health).toBe('unhealthy')
    expect(entry.unhealthySince).not.toBeNull()
    expect(entry.healthFailures, 'the streak must match the verdict').toBeGreaterThanOrEqual(3)
    expect(recorded).toEqual(['unhealthy'])
    expect(notified).toEqual(['unhealthy'])
  })

  it('is not an unhealthy verdict when the health probe is off', async () => {
    const child = {} as ChildProcess
    const entry = makeEntry(false, child)
    const { ctx, notified } = makeCtx()
    await awaitReadiness(ctx, entry, child)

    expect(entry.status).toBe('running')
    expect(entry.health).toBe('disabled')
    expect(entry.unhealthySince).toBeNull()
    expect(notified).toEqual([])
  })
})

describe('the force restart with the health probe off', () => {
  it('neither restarts nor gives up on an entry nothing is probing', () => {
    const entry = makeEntry(false, {} as ChildProcess)
    // The state an older panel left behind: unhealthy, with a streak, and the probe since disabled.
    entry.status = 'running'
    entry.health = 'unhealthy'
    entry.unhealthySince = 0
    const { ctx } = makeCtx()
    expect(shouldForceRestart(ctx, entry, 60_000)).toBe(false)
    expect(healthBudgetSpent(entry)).toBe(false)
  })
})
