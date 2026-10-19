import type { SecretsStore } from '#src/config/secrets'
import type { DestinationStatusView, NotificationDefaults, NotificationsConfig, NotificationTarget, WebhookTarget } from '#src/shared/contracts'
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

/** The event toggles and the throttle: what a destination may inherit, and what it may override. */
type NotificationPolicy = NotificationDefaults

/** Which toggles apply to a reason. `rss` rides the crash toggle: an out-of-memory restart is the same event to a reader. */
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

interface DeliveryResult {
  lastResult: string | null
  lastResultAt: number | null
}

/**
 * Fans supervision events out to the configured destinations.
 *
 * **One list, two kinds.** A destination is a Telegram chat or a webhook; both carry an `enabled`
 * switch, an optional policy of their own, and one row on the page. A workspace may point at
 * several Telegram chats, which is why the bot token is a per-destination secret rather than the
 * singleton it used to be.
 *
 * **Inheritance is the default.** A destination with `useOwnSettings: false` follows
 * `notifications.defaults`, so the common case is configured once instead of per destination. A
 * destination that sets its own opts out entirely — no field is merged, because a half-inherited
 * policy is one nobody can reason about.
 *
 * The throttle is per destination *and* server *and* reason: a flapping server must not flood one
 * destination, and one destination going quiet must not silence another.
 */
export class NotificationService {
  private readonly cooldowns = new Map<string, number>()
  private readonly results = new Map<string, DeliveryResult>()

  constructor(
    private readonly secrets: SecretsStore,
    private readonly getConfig: () => NotificationsConfig,
  ) {}

  /** The general block, as the page edits it. */
  defaults(): NotificationDefaults {
    return { ...this.getConfig().defaults }
  }

  /**
   * Every destination as a row: its own fields, the policy it will actually use, and its last result.
   *
   * The page shows this rather than the raw config, so an inheriting destination displays the
   * inherited toggles — the values a send will use, not the stale ones on disk.
   */
  destinations(): DestinationStatusView[] {
    return this.getConfig().destinations.map((target) => {
      const result = this.results.get(target.id) ?? { lastResult: null, lastResultAt: null }
      const common = {
        id: target.id,
        kind: target.kind,
        enabled: target.enabled,
        useOwnSettings: target.useOwnSettings,
        ...this.effectivePolicy(target),
        lastResult: result.lastResult,
        lastResultAt: result.lastResultAt,
      }
      if (target.kind === 'telegram') {
        return {
          ...common,
          chatId: target.chatId,
          tokenSet: this.secrets.telegramTokenSet(target.id),
          url: null,
          method: null,
          format: null,
          headers: null,
        }
      }
      return {
        ...common,
        chatId: null,
        tokenSet: false,
        url: target.url,
        method: target.method,
        format: target.format,
        headers: target.headers,
      }
    })
  }

  /** The policy a destination actually uses: its own, or the general block's. */
  effectivePolicy(target: NotificationTarget): NotificationPolicy {
    if (target.useOwnSettings) {
      return {
        onCrash: target.onCrash,
        onUnhealthy: target.onUnhealthy,
        onForcedRestart: target.onForcedRestart,
        onRecovered: target.onRecovered,
        onHost: target.onHost,
        onDdns: target.onDdns,
        cooldownMs: target.cooldownMs,
      }
    }
    // No field merges: a half-inherited policy is one nobody can reason about.
    return { ...this.getConfig().defaults }
  }

  /**
   * The destinations that would deliver this event right now.
   *
   * Per destination rather than one boolean for the service: a single answer would either send a
   * host warning somewhere switched off for it, or silence a crash because another destination's
   * cooldown was still running.
   */
  targetsFor(event: NotificationEvent, now = Date.now()): NotificationTarget[] {
    return this.getConfig().destinations.filter((target) => {
      if (!target.enabled)
        return false
      const policy = this.effectivePolicy(target)
      if (!COVERS[event.reason](policy))
        return false
      const until = this.cooldowns.get(this.cooldownKey(target, event)) ?? 0
      return !(policy.cooldownMs > 0 && until > now)
    })
  }

  /** Whether *any* destination would deliver this event. */
  shouldNotify(event: NotificationEvent, now = Date.now()): boolean {
    return this.targetsFor(event, now).length > 0
  }

  /** Starts the cooldown window for every destination about to be asked to send. */
  markSent(event: NotificationEvent, now = Date.now()): void {
    for (const target of this.targetsFor(event, now)) {
      this.cooldowns.set(this.cooldownKey(target, event), now + this.effectivePolicy(target).cooldownMs)
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
    // One destination failing must not stop the others, so each is settled on its own.
    const results = await Promise.all(targets.map(target => this.deliver(target, title, message, event)))
    return results.includes(true)
  }

  /** One destination, one event. A throw is recorded against it and nothing else. */
  private async deliver(target: NotificationTarget, title: string, message: string, event: NotificationEvent): Promise<boolean> {
    try {
      const result = target.kind === 'telegram'
        ? await this.sendTelegram(target, title, message)
        : await sendWebhook(target, { title, message, reason: event.reason, serverId: event.serverId, label: event.label })
      this.remember(target.id, result.ok ? 'sent' : result.error ?? 'send failed')
      return result.ok
    }
    catch (error) {
      this.remember(target.id, errorMessage(error))
      return false
    }
  }

  /** A probe for one destination. */
  async sendTest(id: string, overrides: { chatId?: string } = {}): Promise<{ ok: boolean, error?: string }> {
    const target = this.getConfig().destinations.find(entry => entry.id === id)
    if (target === undefined)
      return { ok: false, error: 'no such destination' }

    const result = target.kind === 'telegram'
      ? await this.testTelegram(id, target.chatId, overrides.chatId)
      : await this.testWebhook(target, id)
    this.remember(id, result.ok ? 'test message sent' : result.error ?? 'test failed')
    return result
  }

  /** A Telegram destination's own token, with the chat id overridable for an unsaved edit. */
  private async testTelegram(id: string, chatId: string, overrideChatId?: string): Promise<{ ok: boolean, error?: string }> {
    const chat = (overrideChatId ?? chatId).trim()
    if (chat.length === 0)
      return { ok: false, error: 'no chat id configured' }
    const token = this.secrets.telegramToken(id)
    if (token === null)
      return { ok: false, error: 'no bot token configured for this destination' }

    return sendTelegramMessage(token, chat, formatTelegramMessage('✅ home-hosted test', ['notifications are wired up correctly']))
  }

  /**
   * A webhook probe, for a saved destination or for a draft the page has not saved.
   *
   * A draft is passed whole, so a URL and its headers can be tried before they are stored — and so
   * a destination's own "test" tests *that* destination, not whichever one comes first.
   */
  async testWebhook(target: Pick<WebhookTarget, 'url' | 'method' | 'format' | 'headers'>, id?: string): Promise<{ ok: boolean, error?: string }> {
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
      this.remember(id, result.ok ? 'test message sent' : result.error ?? 'test failed')
    return result
  }

  /** Lists the chats a destination's bot can see, so its chat id can be picked. */
  async detectChats(id: string, overrides: { botToken?: string } = {}): Promise<{ ok: boolean, chats: Array<{ id: number | string, title: string }>, error?: string }> {
    const token = (overrides.botToken ?? this.secrets.telegramToken(id) ?? '').trim()
    if (token.length === 0)
      return { ok: false, chats: [], error: 'no bot token configured for this destination' }

    const result = await listTelegramChats(token)
    this.remember(id, result.ok ? `${result.chats.length} chat(s) found` : result.error ?? 'detect failed')
    return result
  }

  /** Verifies a token without storing or sending anything. */
  async verifyToken(token: string): Promise<{ ok: boolean, username?: string, error?: string }> {
    return verifyTelegramToken(token)
  }

  private cooldownKey(target: NotificationTarget, event: NotificationEvent): string {
    return `${target.id}:${event.serverId}:${event.reason}`
  }

  private async sendTelegram(target: Extract<NotificationTarget, { kind: 'telegram' }>, title: string, message: string): Promise<{ ok: boolean, error?: string }> {
    if (target.chatId.length === 0)
      return { ok: false, error: 'no chat id configured' }

    const token = this.secrets.telegramToken(target.id)
    if (token === null)
      return { ok: false, error: 'no bot token configured for this destination' }

    // The title is the first line of the message; Telegram gets it bold, the rest as bullets.
    const body = message.split('\n').filter(line => line.length > 0)
    return sendTelegramMessage(token, target.chatId, formatTelegramMessage(title, body))
  }

  /** Records one destination's outcome, keyed by its id. */
  private remember(id: string, message: string): void {
    this.results.set(id, { lastResult: message, lastResultAt: Date.now() })
  }
}
