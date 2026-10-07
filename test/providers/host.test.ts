import process from 'node:process'
import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { availableMemoryBytes, emptyHostView, isSwapCacheFresh, macAvailableBytes, memoryInfo, sampleHost, swapPercentFromPageFile, swapPercentFromSysctl, usedPercent } from '#src/providers/host'
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

  /**
   * The clamp, tested against the *estimate* that makes it necessary.
   *
   * `MemAvailable` is a kernel estimate and can exceed `MemTotal`, and `SwapFree` can exceed
   * `SwapTotal` — either makes the raw ratio negative. The alert is `used >= threshold`, so a
   * negative reading does not merely look odd: it **suppresses the memory alert**. The bounds test
   * above passes on any ordinary machine, which is exactly why this needs a case that is impossible
   * to satisfy by luck.
   */
  it('clamps a percentage the kernel can make nonsensical', () => {
    // `available > total` is the real case: MemAvailable is an estimate, SwapFree can exceed
    // SwapTotal, and the raw ratio goes negative — which would suppress the alert rather than trip it.
    // free > total, the MemAvailable case
    expect(usedPercent(1200, 1000)).toBe(0)
    expect(usedPercent(1000, 1000)).toBe(0)
    expect(usedPercent(400, 1000)).toBe(60)
    // Over-100 cannot arise from the subtraction, but the bound is stated rather than assumed.
    expect(usedPercent(-500, 1000)).toBe(100)
    // A meaningless denominator is 0, not NaN or Infinity.
    expect(usedPercent(10, 0)).toBe(0)
    expect(usedPercent(0, 0)).toBe(0)
  })

  it('reports bounds a live sampling cannot violate', () => {
    const { memoryUsedPercent, swapUsedPercent } = memoryInfo()
    for (const [name, value] of [['memory', memoryUsedPercent], ['swap', swapUsedPercent]] as const) {
      expect(Number.isFinite(value), `${name} must be finite`).toBe(true)
      expect(value, `${name} must not be negative`).toBeGreaterThanOrEqual(0)
      expect(value, `${name} must not exceed 100`).toBeLessThanOrEqual(100)
    }
  })

  /**
   * The two non-Linux swap branches, exercised with the readings their platforms actually produce.
   *
   * This machine is Linux, so these branches never run in CI — which is how their arithmetic drifted
   * from the `/proc` branch's: Linux clamped, these did not, and the alert that consumes them is
   * `used >= threshold`, so a negative silently **suppresses** the swap alert. Passing the real
   * output shape makes the arithmetic reachable without the platform.
   */
  it('reads a macOS vm.swapusage line, clamped', () => {
    // The real shape: `total = 4096.00M  used = 1024.00M  free = 3072.00M  (encrypted)`.
    expect(swapPercentFromSysctl('total = 4096.00M  used = 1024.00M  free = 3072.00M')).toBe(25)
    expect(swapPercentFromSysctl('total = 4096.00M  used = 0.00M  free = 4096.00M')).toBe(0)
    expect(swapPercentFromSysctl('total = 4096.00M  used = 4096.00M  free = 0.00M')).toBe(100)

    // Compressed swap can report used > total; the raw ratio would be negative here.
    expect(swapPercentFromSysctl('total = 4096.00M  used = 5120.00M')).toBe(100)
    // Unparseable output is "nothing known", not "nothing used".
    expect(swapPercentFromSysctl('')).toBe(0)
    expect(swapPercentFromSysctl('vm.swapusage: bad')).toBe(0)
    // A zero total must not divide.
    expect(swapPercentFromSysctl('total = 0.00M  used = 0.00M')).toBe(0)
  })

  it('reads a Windows pagefile CSV row, clamped', () => {
    const header = '\uFEFF"AllocatedBaseSize","CurrentUsage"'
    expect(swapPercentFromPageFile(`${header}\n"4096","1024"`)).toBe(25)
    expect(swapPercentFromPageFile(`${header}\n"4096","0"`)).toBe(0)
    expect(swapPercentFromPageFile(`${header}\n"4096","4096"`)).toBe(100)

    // The pagefile can grow after the snapshot, so CurrentUsage can exceed AllocatedBaseSize.
    expect(swapPercentFromPageFile(`${header}\n"4096","5120"`)).toBe(100)
    // PowerShell prints nothing at all when the cmdlet has no rows.
    expect(swapPercentFromPageFile(header)).toBe(0)
    expect(swapPercentFromPageFile('')).toBe(0)
    expect(swapPercentFromPageFile(`${header}\n"0","0"`)).toBe(0)
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
    // Older `vm_stat` printed no header, so the size comes from `getpagesize` instead. Asserted
    // unconditionally: the old `if (parsed !== null)` guard meant an implementation that refused
    // *every* headerless reading — the failure the test is named for — still passed.
    const headerless = VM_STAT.split('\n').slice(1).join('\n')
    expect(macAvailableBytes(headerless)).toBe(635_000 * getconfPageSize())
    // The count is read from the headerless text, so a wrong one shows up as a wrong total: with
    // the 16384-byte header dropped the free-page figure still has to be the one in the text.
    expect(macAvailableBytes(headerless)).not.toBe(0)
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
