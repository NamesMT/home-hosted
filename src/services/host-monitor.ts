import type { NotificationEvent } from '#src/services/notifications'
import type { HostConfig, HostView } from '#src/shared/contracts'
import { emptyHostView, sampleHost } from '#src/providers/host'

/** Anything that can receive a host-vitals notification; `NotificationService` qualifies. */
export interface HostNotifier {
  notify: (event: NotificationEvent) => void
}

/**
 * Samples host vitals on their own (slower) interval and turns threshold
 * breaches into one notification per transition, not one per sample.
 */
export class HostMonitor {
  private current: HostView
  private lastSampleAt = 0
  private alerting = false

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

  get view(): HostView {
    return this.current
  }

  private notify(event: NotificationEvent): void {
    const targets = Array.isArray(this.notifications) ? this.notifications : [this.notifications]
    for (const service of targets) service.notify(event)
  }

  /** Cheap when the interval has not elapsed; safe to call every tick. */
  async tick(now = Date.now()): Promise<void> {
    const config = this.getConfig()
    if (!config.enabled) {
      if (this.current.enabled)
        this.current = { ...this.current, enabled: false }
      return
    }
    if (now - this.lastSampleAt < config.intervalMs)
      return

    this.lastSampleAt = now
    this.current = await sampleHost(config, this.resolvePath)

    if (this.current.alerts.length > 0) {
      if (!this.alerting) {
        this.alerting = true
        this.notify({
          serverId: 'host',
          label: 'Host',
          reason: 'host',
          detail: this.current.alerts.join('; '),
        })
      }
      return
    }

    if (this.alerting) {
      this.alerting = false
      this.notify({
        serverId: 'host',
        label: 'Host',
        reason: 'host-recovered',
        detail: 'every host threshold is back to normal',
      })
    }
  }
}
