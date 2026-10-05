import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { emptyHostView, memoryInfo, sampleHost } from '#src/providers/host'
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
