import { describe, expect, it } from 'vitest'
import { liveReadings, sumReadings } from '#src/shared/server-readings'

/**
 * The readings of a process that is not running are **absent**, never the last process's numbers.
 *
 * The panel clears `responseMs` and `resources` when a process ends, but a newer UI is served
 * against an older panel (the documented upgrade rule) — and a panel before this release kept them
 * across an **adopted** entry's stop, because that path has no exit event to clear them in. The
 * panel-side fix cannot help a client talking to an older one, which is what this predicate is for.
 *
 * Measured on the built panel before the fix, stopped but still reporting:
 *
 *     stopped unknown Probe 2 Ms RSS 64.2 MB Procs 1
 *     hh_server_cpu_percent{server="keeper",workspace="default"} 0.2
 */
describe('liveReadings', () => {
  const readings = { cpuPercent: 0.2, rssBytes: 64_241_664, processes: 1, sampledAt: 1000 }

  it('reports the numbers of a running process', () => {
    expect(liveReadings({ status: 'running', responseMs: 2, resources: readings })).toEqual({
      responseMs: 2,
      cpuPercent: 0.2,
      rssBytes: 64_241_664,
      processes: 1,
    })
  })

  it('reports nothing for a stopped entry that still carries the numbers', () => {
    expect(liveReadings({ status: 'stopped', responseMs: 2, resources: readings })).toEqual({
      responseMs: null,
      cpuPercent: null,
      rssBytes: null,
      processes: null,
    })
  })

  it('covers every status that is not running', () => {
    // The defect is about *any* end of a process, not only a clean stop: a crash, a conflict and a
    // backoff all have no running process behind their last reading either.
    for (const status of ['starting', 'stopping', 'backoff', 'crashed', 'conflict'] as const) {
      expect(liveReadings({ status, responseMs: 2, resources: readings }).responseMs, `${status} has no live probe`).toBeNull()
      expect(liveReadings({ status, responseMs: 2, resources: readings }).cpuPercent, `${status} has no live CPU`).toBeNull()
    }
  })

  it('treats a missing reading as absent rather than zero', () => {
    // A metric with no reading is absent, never zero: a zero is the value that looks like a
    // measured idle process.
    expect(liveReadings({ status: 'running' })).toEqual({
      responseMs: null,
      cpuPercent: null,
      rssBytes: null,
      processes: null,
    })
  })

  /**
   * An aggregate over several entries is a reading of the set, so one member with no reading makes
   * the total unknown — not smaller.
   *
   * `OverviewView` summed the workspace's live CPU with `liveReadings(server).cpuPercent ?? 0` and
   * printed it as `0.0% cpu now`. A running entry has no reading for the first sampling window, so a
   * workspace whose server had just started claimed a measured `0.0%` — the fabricated idle process
   * the predicate exists to prevent, in the one number that summarises the whole workspace. The same
   * shape summed process memory and printed `0 B`.
   */
  it('sums a reading across entries, or answers nothing when one is absent', () => {
    const running = (cpuPercent: number | null, rssBytes: number | null) => ({ status: 'running' as const, resources: { cpuPercent, rssBytes, processes: 1, sampledAt: 1 } })

    expect(sumReadings([running(12, 100), running(3, 200)], 'cpuPercent')).toBe(15)
    expect(sumReadings([running(12, 100)], 'rssBytes')).toBe(100)
    // One entry with no sample yet: the total is not the other entry's number.
    expect(sumReadings([running(12, 100), running(null, 200)], 'cpuPercent')).toBeNull()
    expect(sumReadings([running(12, 100), { status: 'running' as const }], 'rssBytes')).toBeNull()
    // A stopped entry is absent too, so a workspace of stopped entries has no CPU reading at all.
    expect(sumReadings([{ status: 'stopped' as const, resources: { cpuPercent: 5, rssBytes: 5, processes: 1 } }], 'cpuPercent')).toBeNull()
    // Nothing to sum is a genuine zero: the surface beside it says nothing is running.
    expect(sumReadings([], 'cpuPercent')).toBe(0)
    // An honestly idle process still reports 0, and it must survive as a number.
    expect(sumReadings([running(0, 0)], 'cpuPercent')).toBe(0)
  })
})
