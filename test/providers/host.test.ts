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
