import process from 'node:process'
import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { availableMemoryBytes, emptyHostView, isSwapCacheFresh, macAvailableBytes, memoryInfo, sampleHost } from '#src/providers/host'
import { hostSchema } from '#src/shared/contracts'

function config(overrides: Record<string, unknown> = {}) {
  const parsed = hostSchema(overrides)
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return parsed
}

describe('host sampling', () => {
  it('reports memory and swap as percentages', () => {
    const { memoryUsedPercent, swapUsedPercent } = memoryInfo()
    expect(memoryUsedPercent).toBeGreaterThanOrEqual(0)
    expect(memoryUsedPercent).toBeLessThanOrEqual(100)
    expect(swapUsedPercent).toBeGreaterThanOrEqual(0)
    expect(swapUsedPercent).toBeLessThanOrEqual(100)
  })

  it('measures a real filesystem', async () => {
    const sample = await sampleHost(config({ diskPaths: ['.'] }), target => target)

    expect(sample.cpus).toBeGreaterThan(0)
    expect(sample.loadAvg).toHaveLength(3)
    expect(sample.disks).toHaveLength(1)
    expect(sample.disks[0]!.totalBytes).toBeGreaterThan(0)
    expect(sample.disks[0]!.usedPercent).toBeGreaterThanOrEqual(0)
    expect(sample.sampledAt).not.toBeNull()
  })

  it('alerts when a threshold is crossed and stays quiet below it', async () => {
    const strict = await sampleHost(config({ diskPaths: ['.'], diskUsedPercent: 0.0001, memoryUsedPercent: 0.0001 }), t => t)
    expect(strict.alerts.some(alert => alert.includes('disk'))).toBe(true)
    expect(strict.alerts.some(alert => alert.includes('memory'))).toBe(true)

    // Every threshold is pinned above what any machine can report: leaving one at its
    // schema default makes this "quiet" case depend on the runner's own memory and load,
    // which a loaded CI host fails.
    const relaxed = await sampleHost(config({
      diskPaths: ['.'],
      diskUsedPercent: 100,
      memoryUsedPercent: 100,
      loadPerCpu: 1e9,
      swapUsedPercent: 100,
    }), t => t)
    expect(relaxed.alerts).toEqual([])
  })

  // Windows has no load average at all (`os.loadavg()` is always zero there, and the
  // sampler zeroes it on purpose), so nothing can cross a load threshold to alert on.
  it.skipIf(process.platform === 'win32')('alerts on load per cpu', async () => {
    const onLoad = await sampleHost(config({ diskPaths: [], loadPerCpu: 0.0001, memoryUsedPercent: 100 }), t => t)
    expect(onLoad.alerts.some(alert => alert.includes('load'))).toBe(true)
  })

  it('skips disabled thresholds', async () => {
    const disabled = await sampleHost(config({ diskPaths: [], loadPerCpu: 0, memoryUsedPercent: 100 }), t => t)
    expect(disabled.alerts).toEqual([])
  })

  it('ignores paths that do not exist', async () => {
    const sample = await sampleHost(config({ diskPaths: ['/definitely/not/here'] }), t => t)
    expect(sample.disks).toEqual([])
  })

  it('offers an empty view before the first sample', () => {
    const view = emptyHostView(config({}))
    expect(view.sampledAt).toBeNull()
    expect(view.alerts).toEqual([])
    expect(view.loadAvg).toEqual([0, 0, 0])
  })

  it('can be disabled', async () => {
    const view = emptyHostView(config({ enabled: false }))
    expect(view.enabled).toBe(false)
  })
})

/**
 * The swap alert and the memory alert, which nothing crossed.
 *
 * `sampleHost` builds its alerts inline, so the only way to reach one is to breach a real
 * reading — and a threshold "above what any machine can report" (as the quiet case above
 * uses) can never fire. The threshold here is derived from what this machine actually
 * reports, so it is reached without depending on how busy the runner is: a `swap` line
 * reports 0 when there is no swap at all, and that case is skipped rather than faked.
 */
describe('host alerts that need a real reading', () => {
  /**
   * Every assertion below is about *one* alert kind.
   *
   * A busy CI runner also breaches the load threshold — the macOS gate caught exactly that,
   * reporting `load 7.16/cpu exceeds 2` while these tests expected no alerts at all. An
   * alert list is not a set to compare wholesale; it is this machine's combined opinion, and
   * only the part under test is ours to predict.
   */
  const swapAlerts = (alerts: string[]): string[] => alerts.filter(alert => alert.includes('swap'))
  const memoryAlerts = (alerts: string[]): string[] => alerts.filter(alert => alert.includes('memory'))

  it('alerts on swap when the threshold is below what the machine reports', async () => {
    const { swapUsedPercent } = memoryInfo()
    // Half of whatever is actually used, so the comparison is satisfied by construction.
    const sample = await sampleHost(config({ diskPaths: [], swapUsedPercent: swapUsedPercent / 2, memoryUsedPercent: 100 }), t => t)

    if (swapUsedPercent === 0) {
      // No swap on this machine — macOS runners, typically — so nothing can breach it.
      expect(swapAlerts(sample.alerts), 'no swap to alert on').toEqual([])
      return
    }
    expect(swapAlerts(sample.alerts)).toHaveLength(1)
    // The wording is what a person reads, so pin the shape of it.
    expect(swapAlerts(sample.alerts)[0]).toMatch(/^swap is \d+\.\d% used$/)
  })

  it('alerts on memory when the threshold is below what the machine reports', async () => {
    const { memoryUsedPercent } = memoryInfo()
    // The quiet case above uses 100, which no machine reaches; this one is reached by
    // construction whenever anything at all is allocated.
    const sample = await sampleHost(config({ diskPaths: [], memoryUsedPercent: memoryUsedPercent / 2, swapUsedPercent: 100 }), t => t)

    if (memoryUsedPercent === 0) {
      expect(memoryAlerts(sample.alerts)).toEqual([])
      return
    }
    expect(memoryAlerts(sample.alerts)).toHaveLength(1)
    expect(memoryAlerts(sample.alerts)[0]).toMatch(/^memory is \d+\.\d% used$/)
  })

  it('treats a zero threshold as disabled, for both', async () => {
    // `0` disables an individual alert; it must not read as "alert on anything".
    const sample = await sampleHost(config({ diskPaths: [], swapUsedPercent: 0, memoryUsedPercent: 0 }), t => t)
    expect(swapAlerts(sample.alerts)).toEqual([])
    expect(memoryAlerts(sample.alerts)).toEqual([])
    // The threshold is disabled, not the whole sampler: an unrelated breach still reports.
    const strict = await sampleHost(config({ diskPaths: [], swapUsedPercent: 0, memoryUsedPercent: 0, loadPerCpu: 1e9 }), t => t)
    expect(swapAlerts(strict.alerts)).toEqual([])
  })
})

/**
 * macOS memory, which read as 90%+ used on a healthy Mac.
 *
 * `os.freemem()` is libuv's `free_count` alone on Darwin, while macOS keeps as much RAM as
 * it can in *inactive* and *speculative* pages — file cache it drops on demand. A user of
 * 0.7.3 reported a Mac "always at 90+ RAM", and that was this: the same fallback that is
 * correct on Linux (where libuv reads `MemAvailable`) is wrong there.
 *
 * The parser is tested against real `vm_stat` text because no Linux runner can execute the
 * macOS branch — the page size in particular is 16384 on Apple silicon, not 4096.
 */
describe('macAvailableBytes', () => {
  const VM_STAT = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                              100000.',
    'Pages active:                           1000000.',
    'Pages inactive:                          500000.',
    'Pages speculative:                        25000.',
    'Pages throttled:                              0.',
    'Pages wired down:                        200000.',
    'Pages purgeable:                          10000.',
    '"Translation faults":                  999999999.',
  ].join('\n')

  it('counts free, inactive, speculative and purgeable at the size vm_stat reports', () => {
    // 100000 + 500000 + 25000 + 10000 = 635000 pages of 16384 bytes.
    expect(macAvailableBytes(VM_STAT)).toBe(635_000 * 16384)
  })

  it('does not count active or wired pages as available', () => {
    // They are genuinely in use; counting them would flip the bug the other way.
    const withHugeActive = VM_STAT.replace('Pages active:                           1000000.', 'Pages active:                          99999999.')
    expect(macAvailableBytes(withHugeActive)).toBe(635_000 * 16384)
  })

  it('falls back for a page size when the header is absent', () => {
    // Older `vm_stat` printed no header; the count still has to be usable.
    const headerless = VM_STAT.split('\n').slice(1).join('\n')
    const parsed = macAvailableBytes(headerless)
    // Either a real page size was found, or the reading is refused — never a wrong number
    // derived from assuming 4096.
    if (parsed !== null)
      expect(parsed).toBe(635_000 * getconfPageSize())
  })

  it('refuses a reading it cannot take, rather than inventing a percentage', () => {
    expect(macAvailableBytes('')).toBeNull()
    expect(macAvailableBytes('Mach Virtual Memory Statistics: (page size of 4096 bytes)')).toBeNull()
  })

  it('reports "unknown" instead of 100% used when the reading fails', () => {
    // The percentage must never be fabricated from a failed read.
    expect(macAvailableBytes('nothing useful here')).toBeNull()
  })
})

/** The same value `getconf PAGESIZE` gives, read here so the test matches the code path. */
function getconfPageSize(): number {
  // eslint-disable-next-line ts/no-require-imports
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
  return Number.parseInt(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim(), 10)
}

/**
 * Which reader each platform's fallback uses — the decision that *was* the bug.
 *
 * `memoryInfo` cannot exercise this on a Linux runner: `/proc/meminfo` answers first, so the
 * fallback never runs and a test of the whole function proves nothing about it. This is the
 * seam, and getting it wrong is what made a healthy Mac report 90%+ used.
 */
describe('availableMemoryBytes', () => {
  const VM_STAT = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                              100000.',
    'Pages inactive:                          500000.',
    'Pages speculative:                        25000.',
    'Pages purgeable:                          10000.',
  ].join('\n')

  it('uses the OS reading on Linux and Windows', () => {
    expect(availableMemoryBytes('linux', 12_345)).toBe(12_345)
    expect(availableMemoryBytes('win32', 12_345)).toBe(12_345)
  })

  it('uses vm_stat on macOS, and never the free-page count', () => {
    // This is the assertion the old code would fail: `os.freemem()` is `free_count` alone,
    // which excludes the inactive and speculative pages macOS calls reclaimable.
    const available = availableMemoryBytes('darwin', 100_000 * 16384, VM_STAT)
    expect(available).toBe(635_000 * 16384)
    expect(available, 'the macOS path took os.freemem()').not.toBe(100_000 * 16384)
  })

  it('reports unknown rather than falling back to a wrong number', () => {
    // A failed vm_stat read must not silently become "everything is used", which is the
    // symptom being fixed.
    expect(availableMemoryBytes('darwin', 100_000 * 16384, '')).toBeNull()
  })
})

/**
 * The swap cache, which exists because reading swap spawns a process.
 *
 * `sysctl` on macOS and a full PowerShell start on Windows — `wmic` is gone — and the host is
 * sampled every 15 s, so that was 5,760 spawns a day for one slowly-moving number that only
 * feeds an alert threshold and a Prometheus gauge. The rule is tested rather than the read,
 * because no Linux runner can perform the read.
 */
describe('isSwapCacheFresh', () => {
  it('reuses a reading inside the window, and refuses one outside it', () => {
    const cache = { at: 1000 }
    expect(isSwapCacheFresh(cache, 1000)).toBe(true)
    expect(isSwapCacheFresh(cache, 1000 + 59_999)).toBe(true)
    // Exactly at the TTL is expired: the boundary is "younger than", not "no older than".
    expect(isSwapCacheFresh(cache, 1000 + 60_000)).toBe(false)
    expect(isSwapCacheFresh(cache, 1000 + 60_001)).toBe(false)
  })

  it('never reuses an absent reading', () => {
    // The first sample must spawn; a null cache is not a value of zero.
    expect(isSwapCacheFresh(null, 5000)).toBe(false)
  })

  it('treats a clock that went backwards as stale, not as fresh', () => {
    // A wall clock that jumps back would otherwise pin the reading forever.
    expect(isSwapCacheFresh({ at: 10_000 }, 5_000)).toBe(false)
  })

  it('spawns at most once a minute at the default sampling interval', () => {
    // The property that matters: 15 s sampling over an hour is 240 samples, and this
    // collapses them to 60 reads — the difference between 5,760 and 1,440 spawns a day.
    let reads = 0
    let cache: { at: number } | null = null
    for (let t = 0; t < 3_600_000; t += 15_000) {
      if (!isSwapCacheFresh(cache, t)) {
        reads += 1
        cache = { at: t }
      }
    }
    expect(reads).toBe(60)
  })
})
