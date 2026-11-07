import type { Entry } from '#src/services/supervisor/entry'
import { describe, expect, it, vi } from 'vitest'

/**
 * A probe answers for the run it started in.
 *
 * `probeEntry` already discarded a stale *health* verdict, but the occupancy half — which runs even
 * while an entry is stopped, so the card can say "free" — wrote `entry.portState` after an unguarded
 * await. A probe launched against a dying run therefore resolved later and stamped its answer onto
 * the *next* run: the card showed "free" for a port the new run was serving, and the supervisor uses
 * that same field to decide a conflict is over.
 *
 * `portAccepts` is replaced with a gate the test opens by hand, so the interleaving is deterministic
 * rather than a race that happens to pass on a fast machine.
 */
const gate = vi.hoisted(() => {
  let open: () => void = () => {}
  let release: Promise<void> = Promise.resolve()
  return {
    result: true,
    hold(): void {
      release = new Promise<void>((resolve) => { open = resolve })
    },
    async pass(): Promise<void> { await release },
    open(): void { open() },
  }
})

vi.mock('#src/services/supervisor/port-preflight', async (importOriginal) => {
  const original = await importOriginal<typeof import('#src/services/supervisor/port-preflight')>()
  return {
    ...original,
    portAccepts: async () => {
      await gate.pass()
      return gate.result
    },
  }
})

const { probeEntry } = await import('#src/services/supervisor/health')

/** The narrowest `Entry` the occupancy branch reads. */
function makeEntry(port: number): Entry {
  return {
    config: { id: 'web', port, health: { enabled: false, intervalMs: 1000, timeoutMs: 100 } },
    status: 'stopped',
    portState: 'unknown',
    runToken: 0,
    lastOccupancyProbeAt: 0,
    lastProbeAt: 0,
    probing: false,
  } as unknown as Entry
}

const ctx = {} as never

describe('the occupancy probe across a run', () => {
  it('does not write its answer onto a newer run', async () => {
    const entry = makeEntry(45501)
    gate.result = false
    gate.hold()
    const probe = probeEntry(ctx, entry, 20_000)

    // A stop (which bumps `runToken`) lands while the probe is still out, and a new run starts.
    entry.runToken += 1
    entry.status = 'running'
    gate.open()
    await probe

    expect(entry.portState, 'the old run must not stamp the new one').toBe('unknown')
  })

  it('does not write an answer for a port the config no longer names', async () => {
    const entry = makeEntry(45503)
    gate.result = false
    gate.hold()
    const probe = probeEntry(ctx, entry, 20_000)
    entry.config.port = 45504
    gate.open()
    await probe
    expect(entry.portState).toBe('unknown')
  })

  it('still records the answer for the run it belongs to', async () => {
    const entry = makeEntry(45502)
    gate.result = true
    // A resolved release, so `pass()` returns immediately.
    gate.open()
    await probeEntry(ctx, entry, 20_000)
    expect(entry.portState).toBe('in-use')
  })
})
