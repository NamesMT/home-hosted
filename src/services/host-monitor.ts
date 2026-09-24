import type { NotificationService } from '#src/services/notifications'
import type { HostConfig, HostView } from '#src/shared/contracts'
import { emptyHostView, sampleHost } from '#src/providers/host'

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
    private readonly notifications: NotificationService,
  ) {
    this.current = emptyHostView(getConfig())
  }

  get view(): HostView {
    return this.current
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
        this.notifications.notify({
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
      this.notifications.notify({
        serverId: 'host',
        label: 'Host',
        reason: 'host-recovered',
        detail: 'every host threshold is back to normal',
      })
    }
  }
}
