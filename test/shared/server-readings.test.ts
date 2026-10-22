import { describe, expect, it } from 'vitest'
import { liveReadings } from '#src/shared/server-readings'

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
})
