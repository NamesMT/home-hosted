import type { NotificationEvent } from '#src/services/notifications'
import type { HostConfig, HostView } from '#src/shared/contracts'
import { emptyHostView, hostBreaches, sampleHost } from '#src/providers/host'

/** Anything that can receive a host-vitals notification; `NotificationService` qualifies. */
export interface HostNotifier {
  notify: (event: NotificationEvent) => void
}

/** A sample older than this many intervals is no longer a reading of the machine. */
const STALE_INTERVALS = 3

/**
 * Samples host vitals on their own (slower) interval and turns threshold
 * breaches into one notification per transition, not one per sample.
 */
export class HostMonitor {
  private current: HostView
  /** The unsampled frame shown while the last sample is stale; built once, not per frame. */
  private staleView: HostView | null = null
  private lastSampleAt = 0
  /** The breach kinds last notified: a new kind is news even while another is standing. */
  private alerting = new Set<string>()
  private sampling = false

  constructor(
    private readonly getConfig: () => HostConfig,
    private readonly resolvePath: (target: string) => string,
    /**
     * Every workspace's notification service: host vitals are panel-wide, so a
     * breach reaches each workspace that asked for host alerts.
     */
    private readonly notifications: HostNotifier | HostNotifier[],
  ) {
    this.current = emptyHostView(getConfig())
  }

  /**
   * The frame's host view. A sample older than a few intervals (a sampler that stopped returning)
   * is published as unsampled rather than as the machine's state: readings stay absent until a
   * fresh sample lands.
   */
  get view(): HostView {
    const sampledAt = this.current.sampledAt
    if (sampledAt === null || !this.current.enabled)
      return this.current
    const config = this.getConfig()
    if (Date.now() - sampledAt <= STALE_INTERVALS * config.intervalMs)
      return this.current
    this.staleView ??= emptyHostView(config)
    return this.staleView
  }

  private notify(event: NotificationEvent): void {
    const targets = Array.isArray(this.notifications) ? this.notifications : [this.notifications]
    for (const service of targets) service.notify(event)
  }

  /** Cheap when the interval has not elapsed; safe to call every tick. */
  async tick(now = Date.now()): Promise<void> {
    const config = this.getConfig()
    if (!config.enabled) {
      // The last sample is not the machine's state any more: no readings, and a standing alert is
      // closed so the receiver is not left reading a breach nothing watches.
      if (this.current.enabled || this.current.sampledAt !== null)
        this.current = emptyHostView(config)
      this.staleView = null
      this.settle(new Set(), 'host sampling was switched off')
      return
    }
    if (this.sampling || now - this.lastSampleAt < config.intervalMs)
      return

    this.lastSampleAt = now
    // One sample at a time: a slow disk or sensor must not stack samples up behind it.
    this.sampling = true
    try {
      this.current = await sampleHost(config, this.resolvePath)
      this.staleView = null
    }
    finally {
      this.sampling = false
    }

    const breaches = hostBreaches(config, this.current)
    const kinds = new Set(breaches.map(breach => breach.kind))
    if ([...kinds].some(kind => !this.alerting.has(kind))) {
      this.alerting = kinds
      this.notify({
        serverId: 'host',
        label: 'Host',
        reason: 'host',
        detail: this.current.alerts.join('; '),
      })
      return
    }
    this.settle(kinds, 'every host threshold is back to normal')
  }

  /** Records the standing breaches, announcing recovery when the last one clears. */
  private settle(kinds: Set<string>, recoveredDetail: string): void {
    const wasAlerting = this.alerting.size > 0
    this.alerting = kinds
    if (wasAlerting && kinds.size === 0) {
      this.notify({
        serverId: 'host',
        label: 'Host',
        reason: 'host-recovered',
        detail: recoveredDetail,
      })
    }
  }
}
