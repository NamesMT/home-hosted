import type { NotificationEvent } from '#src/services/notifications'
import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { HostMonitor } from '#src/services/host-monitor'
import { hostSchema } from '#src/shared/contracts'

/**
 * `HostMonitor` is the half of host vitals that decides whether anyone is *told*:
 * `sampleHost` reads the machine, this turns a threshold breach into one
 * notification per transition rather than one per sample — and one recovery when it
 * clears. Every assertion here is about that transition, not about the numbers.
 */

function config(overrides: Record<string, unknown> = {}) {
  const parsed = hostSchema(overrides)
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return parsed
}

/** A notifier that records what it was handed. */
function recorder(): { events: NotificationEvent[], notify: (event: NotificationEvent) => void } {
  const events: NotificationEvent[] = []
  return { events, notify: (event: NotificationEvent) => { events.push(event) } }
}

/** Thresholds no machine can cross, so the sample is quiet on any runner. */
const QUIET = {
  diskPaths: ['.'],
  diskUsedPercent: 100,
  memoryUsedPercent: 100,
  loadPerCpu: 1e9,
  swapUsedPercent: 100,
}

/** Thresholds crossed by anything, so the sample always alerts. */
const ALERTING = {
  diskPaths: ['.'],
  diskUsedPercent: 0.0001,
  memoryUsedPercent: 0.0001,
  loadPerCpu: 1e9,
  swapUsedPercent: 100,
}

describe('hostMonitor', () => {
  it('notifies once when a threshold is crossed, not once per sample', async () => {
    const sink = recorder()
    // Re-sample on every tick, so a naive implementation would notify each time.
    const monitor = new HostMonitor(() => config({ ...ALERTING, intervalMs: 5000 }), t => t, sink)

    await monitor.tick(10_000)
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]).toMatchObject({ serverId: 'host', reason: 'host' })
    expect(sink.events[0]!.detail.length).toBeGreaterThan(0)

    // Still breaching: a second sample is not news.
    await monitor.tick(20_000)
    await monitor.tick(30_000)
    expect(sink.events).toHaveLength(1)
  })

  it('notifies recovery exactly once, and only after it was alerting', async () => {
    const sink = recorder()
    let thresholds: Record<string, unknown> = { ...ALERTING, intervalMs: 5000 }
    const monitor = new HostMonitor(() => config(thresholds), t => t, sink)

    await monitor.tick(10_000)
    expect(sink.events).toHaveLength(1)
    expect(monitor.view.alerts.length).toBeGreaterThan(0)

    // Back to normal: one recovery, and the view says so.
    thresholds = { ...QUIET, intervalMs: 5000 }
    await monitor.tick(20_000)
    expect(sink.events).toHaveLength(2)
    expect(sink.events[1]).toMatchObject({ reason: 'host-recovered' })
    expect(monitor.view.alerts).toEqual([])

    // Staying healthy is not news either.
    await monitor.tick(30_000)
    await monitor.tick(40_000)
    expect(sink.events).toHaveLength(2)
  })

  it('never reports a recovery it did not first report a breach for', async () => {
    const sink = recorder()
    const monitor = new HostMonitor(() => config({ ...QUIET, intervalMs: 5000 }), t => t, sink)

    await monitor.tick(10_000)
    await monitor.tick(20_000)
    expect(sink.events).toEqual([])
  })

  it('honours the sample interval, so a tick storm is not a sample storm', async () => {
    const sink = recorder()
    const monitor = new HostMonitor(() => config({ ...ALERTING, intervalMs: 60_000 }), t => t, sink)

    await monitor.tick(100_000)
    expect(sink.events).toHaveLength(1)

    // Object identity, not `sampledAt`. A sample assigns a *fresh* view object, so a tick that
    // skips leaves the reference untouched — and one that samples replaces it.
    //
    // `sampledAt` looks like it would work and does not, in either direction: it is a wall
    // clock (`sampleHost` stamps `Date.now()`), while these ticks move only *simulated* time.
    // Two samples a tick apart take about a millisecond of real time, so they can land on the
    // same millisecond — which made this test fail intermittently on CI, and would equally
    // have let a genuine re-sample inside the interval pass unnoticed.
    const firstSample = monitor.view
    expect(firstSample.sampledAt).not.toBeNull()

    // Inside the interval nothing is re-sampled.
    await monitor.tick(110_000)
    await monitor.tick(120_000)
    expect(monitor.view, 'a tick inside the interval re-sampled').toBe(firstSample)

    // Past it, a new sample lands.
    await monitor.tick(200_000)
    expect(monitor.view, 'a tick past the interval did not re-sample').not.toBe(firstSample)
  })

  it('stops sampling when disabled, and says so in the view', async () => {
    const sink = recorder()
    let enabled = true
    const monitor = new HostMonitor(
      () => config({ ...ALERTING, intervalMs: 5000, enabled }),
      t => t,
      sink,
    )

    await monitor.tick(10_000)
    expect(sink.events).toHaveLength(1)

    enabled = false
    await monitor.tick(20_000)
    expect(monitor.view.enabled).toBe(false)
    // Disabled means no further sampling and no further notifications.
    const after = sink.events.length
    await monitor.tick(30_000)
    expect(sink.events).toHaveLength(after)
  })

  it('fans one breach out to every workspace that asked for host alerts', async () => {
    const first = recorder()
    const second = recorder()
    const monitor = new HostMonitor(() => config({ ...ALERTING, intervalMs: 5000 }), t => t, [first, second])

    await monitor.tick(10_000)
    expect(first.events).toHaveLength(1)
    expect(second.events).toHaveLength(1)
    expect(first.events[0]).toEqual(second.events[0])
  })

  it('accepts a single notifier as readily as a list', async () => {
    const only = recorder()
    const monitor = new HostMonitor(() => config({ ...ALERTING, intervalMs: 5000 }), t => t, only)

    await monitor.tick(10_000)
    expect(only.events).toHaveLength(1)
  })

  it('starts from an empty sample so a first frame is never a stale one', () => {
    const monitor = new HostMonitor(() => config({ ...QUIET }), t => t, recorder())
    expect(monitor.view.sampledAt).toBeNull()
    expect(monitor.view.alerts).toEqual([])
  })
})
