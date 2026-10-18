import type { SecretsStore } from '#src/config/secrets'
import type { NotificationsConfig, TelegramStatus, WebhookStatus, WebhookTarget } from '#src/shared/contracts'
import { logger } from '#src/helpers/logger'
import { formatTelegramMessage, listTelegramChats, sendTelegramMessage, verifyTelegramToken } from '#src/providers/telegram'
import { sendWebhook, targetProblem } from '#src/providers/webhook'
import { errorMessage } from '#src/shared/error-message'

export type NotificationReason = 'crash' | 'unhealthy' | 'forced-restart' | 'recovered' | 'rss' | 'host' | 'host-recovered' | 'ddns' | 'ddns-error'

export interface NotificationEvent {
  serverId: string
  label: string
  reason: NotificationReason
  detail: string
}

const REASON_LABEL: Record<NotificationReason, string> = {
  'crash': 'gave up restarting',
  'unhealthy': 'health check failing',
  'forced-restart': 'force restarted',
  'recovered': 'recovered',
  'rss': 'exceeded its memory limit',
  'host': 'host thresholds breached',
  'host-recovered': 'host thresholds recovered',
  'ddns': 'updated a dynamic DNS record',
  'ddns-error': 'hit a dynamic DNS error',
}

const TITLE: Record<NotificationReason, string> = {
  'crash': '🔴 server down',
  'unhealthy': '🟠 server unhealthy',
  'forced-restart': '🔁 server force restarted',
  'recovered': '🟢 server recovered',
  'rss': '🔴 server over its memory limit',
  'host': '🟠 host warning',
  'host-recovered': '🟢 host recovered',
  'ddns': '🌐 DNS updated',
  'ddns-error': '🌐 DNS update failed',
}

/** The event toggles and the throttle, which every target answers the same way. */
interface NotificationPolicy {
  enabled: boolean
  onCrash: boolean
  onUnhealthy: boolean
  onForcedRestart: boolean
  onRecovered: boolean
  onHost: boolean
  onDdns: boolean
  cooldownMs: number
}

/**
 * Which toggles apply to a reason. `rss` rides the crash toggle: an out-of-memory restart is
 * the same kind of event to anyone reading the alert.
 */
const COVERS: Record<NotificationReason, (policy: NotificationPolicy) => boolean> = {
  'crash': policy => policy.onCrash,
  'rss': policy => policy.onCrash,
  'unhealthy': policy => policy.onUnhealthy,
  'forced-restart': policy => policy.onForcedRestart,
  'recovered': policy => policy.onRecovered,
  'host': policy => policy.onHost,
  'host-recovered': policy => policy.onHost,
  'ddns': policy => policy.onDdns,
  'ddns-error': policy => policy.onDdns,
}

/**
 * One place an event can go. Telegram is a single target; each webhook is its own, so the
 * list can hold a phone, a chat channel and a dashboard at once.
 */
type Delivery = { kind: 'telegram' } | { kind: 'webhook', target: WebhookTarget }

/** A delivery's identity, for its cooldown key and its last-result record. */
function deliveryKey(delivery: Delivery): string {
  return delivery.kind === 'telegram' ? 'telegram' : `webhook:${delivery.target.id}`
}

interface DeliveryResult {
  lastResult: string | null
  lastResultAt: number | null
}

/**
 * Fans supervision events out to the configured targets.
 *
 * Two transports, one policy shape: a single Telegram chat, and a *list* of webhooks. The list
 * is what makes the second general — a target carries its own URL, method, body format and
 * headers, so ntfy (plain body with `Title`/`Priority` headers), a JSON receiver and a
 * bearer-token endpoint are all configuration rather than code.
 *
 * Toggles are per target, so crashes to one chat and only host warnings to a phone works. The
 * throttle is per target *and* server *and* reason: a flapping server must not flood one
 * destination, and one destination going quiet must not silence another.
 */
export class NotificationService {
  private readonly cooldowns = new Map<string, number>()
  private lastResult: string | null = null
  private lastResultAt: number | null = null
  /** Telegram's own record and each webhook's, keyed by `deliveryKey`. */
  private readonly results = new Map<string, DeliveryResult>()

  constructor(
    private readonly secrets: SecretsStore,
    private readonly getConfig: () => NotificationsConfig,
  ) {}

  get telegramTokenSet(): boolean {
    return this.secrets.telegramTokenSet
  }

  status(): TelegramStatus {
    return {
      ...this.policyOf(this.getConfig().telegram),
      tokenSet: this.secrets.telegramTokenSet,
      chatId: this.getConfig().telegram.chatId,
      ...this.resultOf('telegram'),
    }
  }

  /** Every configured webhook with its own last delivery outcome, in config order. */
  webhookStatuses(): WebhookStatus[] {
    return this.getConfig().webhooks.map(target => ({
      id: target.id,
      url: target.url,
      method: target.method,
      format: target.format,
      headers: target.headers,
      ...this.policyOf(target),
      ...this.resultOf(`webhook:${target.id}`),
    }))
  }

  /** The policy columns of a target, whatever else its own status carries. */
  private policyOf(policy: NotificationPolicy): NotificationPolicy {
    return {
      enabled: policy.enabled,
      onCrash: policy.onCrash,
      onUnhealthy: policy.onUnhealthy,
      onForcedRestart: policy.onForcedRestart,
      onRecovered: policy.onRecovered,
      onHost: policy.onHost,
      onDdns: policy.onDdns,
      cooldownMs: policy.cooldownMs,
    }
  }

  private resultOf(key: string): DeliveryResult {
    return this.results.get(key) ?? { lastResult: null, lastResultAt: null }
  }

  /**
   * The targets that would deliver this event right now.
   *
   * Per target rather than one boolean for the service: a single answer would either send a
   * host warning somewhere switched off for it, or silence a crash because another target's
   * cooldown was still running.
   */
  targetsFor(event: NotificationEvent, now = Date.now()): Delivery[] {
    const config = this.getConfig()
    const candidates: Delivery[] = [
      { kind: 'telegram' },
      ...config.webhooks.map(target => ({ kind: 'webhook', target }) as const),
    ]

    return candidates.filter((delivery) => {
      const policy = this.policyOf(delivery.kind === 'telegram' ? config.telegram : delivery.target)
      if (!policy.enabled || !COVERS[event.reason](policy))
        return false
      const until = this.cooldowns.get(this.cooldownKey(delivery, event)) ?? 0
      return !(policy.cooldownMs > 0 && until > now)
    })
  }

  /** Whether *any* target would deliver this event. */
  shouldNotify(event: NotificationEvent, now = Date.now()): boolean {
    return this.targetsFor(event, now).length > 0
  }

  /** Starts the cooldown window for every target about to be asked to send. */
  markSent(event: NotificationEvent, now = Date.now()): void {
    for (const delivery of this.targetsFor(event, now)) {
      const policy = this.policyOf(delivery.kind === 'telegram' ? this.getConfig().telegram : delivery.target)
      this.cooldowns.set(this.cooldownKey(delivery, event), now + policy.cooldownMs)
    }
  }

  /** Fire-and-forget by design: supervision must never wait on a chat or webhook API. */
  notify(event: NotificationEvent): void {
    void this.dispatch(event).catch((error: unknown) => {
      logger.warn(`notification failed: ${errorMessage(error)}`)
    })
  }

  async dispatch(event: NotificationEvent): Promise<boolean> {
    // `targetsFor` owns the toggles and the cooldown, so the policy lives once.
    const targets = this.targetsFor(event)
    if (targets.length === 0)
      return false
    this.markSent(event)

    const title = TITLE[event.reason]
    const message = `${event.label} (${event.serverId}) ${REASON_LABEL[event.reason]}\n${event.detail}`
    // One target failing must not stop the others, so each is settled on its own.
    const results = await Promise.all(targets.map(delivery => this.deliver(delivery, title, message, event)))
    return results.includes(true)
  }

  /** One target, one event. A throw is recorded against that target and nothing else. */
  private async deliver(delivery: Delivery, title: string, message: string, event: NotificationEvent): Promise<boolean> {
    const key = deliveryKey(delivery)
    try {
      if (delivery.kind === 'telegram') {
        const result = await this.sendTelegram(title, message)
        this.remember(key, result.ok ? 'sent' : result.error ?? 'send failed')
        return result.ok
      }

      const result = await sendWebhook(delivery.target, {
        title,
        message,
        reason: event.reason,
        serverId: event.serverId,
        label: event.label,
      })
      this.remember(key, result.ok ? 'sent' : result.error ?? 'send failed')
      return result.ok
    }
    catch (error) {
      this.remember(key, errorMessage(error))
      return false
    }
  }

  /** Used by the "send test" button against the Telegram card. */
  async sendTest(overrides: { botToken?: string, chatId?: string } = {}): Promise<{ ok: boolean, error?: string }> {
    const chatId = overrides.chatId ?? this.getConfig().telegram.chatId
    if (chatId.length === 0)
      return { ok: false, error: 'no chat id configured' }

    const token = this.resolveToken(overrides.botToken)
    if (token === null)
      return { ok: false, error: 'no bot token configured' }

    const result = await sendTelegramMessage(
      token,
      chatId,
      formatTelegramMessage('✅ home-hosted test', ['notifications are wired up correctly']),
    )
    this.remember('telegram', result.ok ? 'test message sent' : result.error ?? 'test failed')
    return result
  }

  /**
   * A probe for one webhook target, or for a draft the page has not saved.
   *
   * A draft is passed whole, so a URL and its headers can be tried before they are stored — and
   * so a target's own "test" tests *that* target, not whichever one comes first.
   */
  async sendWebhookTest(target: Pick<WebhookTarget, 'url' | 'method' | 'format' | 'headers'>, id?: string): Promise<{ ok: boolean, error?: string }> {
    const problem = targetProblem(target, { requireUrl: true })
    if (problem !== null)
      return { ok: false, error: problem }

    const result = await sendWebhook(target, {
      title: 'home-hosted test',
      message: 'notifications are wired up correctly',
      reason: 'test',
      serverId: '',
      label: '',
    })
    if (id !== undefined)
      this.remember(`webhook:${id}`, result.ok ? 'test message sent' : result.error ?? 'test failed')
    return result
  }

  async detectChats(overrides: { botToken?: string } = {}): Promise<{ ok: boolean, chats: Array<{ id: number | string, title: string }>, error?: string }> {
    const token = this.resolveToken(overrides.botToken)
    if (token === null)
      return { ok: false, chats: [], error: 'no bot token configured' }

    const result = await listTelegramChats(token)
    this.remember('telegram', result.ok ? `${result.chats.length} chat(s) found` : result.error ?? 'detect failed')
    return result
  }

  /** Verifies a token without sending anything. */
  async verifyToken(token: string): Promise<{ ok: boolean, username?: string, error?: string }> {
    return verifyTelegramToken(token)
  }

  private cooldownKey(delivery: Delivery, event: NotificationEvent): string {
    return `${deliveryKey(delivery)}:${event.serverId}:${event.reason}`
  }

  private resolveToken(tokenOverride?: string): string | null {
    const token = tokenOverride?.trim() ?? this.secrets.telegramToken ?? ''
    return token.length > 0 ? token : null
  }

  private async sendTelegram(title: string, message: string): Promise<{ ok: boolean, error?: string }> {
    const telegram = this.getConfig().telegram
    if (telegram.chatId.length === 0)
      return { ok: false, error: 'no chat id configured' }

    const token = this.resolveToken()
    if (token === null)
      return { ok: false, error: 'no bot token configured' }

    // The title is the first line of the message; Telegram gets it bold, the rest as bullets.
    const body = message.split('\n').filter(line => line.length > 0)
    return sendTelegramMessage(token, telegram.chatId, formatTelegramMessage(title, body))
  }

  /**
   * Records one target's outcome. The service-wide pair mirrors the most recent attempt, so a
   * reader that only knows the older single field still sees something true.
   */
  private remember(key: string, message: string): void {
    const at = Date.now()
    this.results.set(key, { lastResult: message, lastResultAt: at })
    this.lastResult = message
    this.lastResultAt = at
  }
}
