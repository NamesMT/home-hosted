import type { SecretsStore } from '#src/config/secrets'
import type { LogsConfig, NotificationsConfig, TelegramStatus } from '#src/shared/contracts'
import { logger } from '#src/helpers/logger'
import { formatTelegramMessage, listTelegramChats, sendTelegramMessage, verifyTelegramToken } from '#src/providers/telegram'

export type NotificationReason = 'crash' | 'unhealthy' | 'forced-restart' | 'recovered' | 'rss' | 'host' | 'host-recovered'

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
}

const TITLE: Record<NotificationReason, string> = {
  'crash': '🔴 server down',
  'unhealthy': '🟠 server unhealthy',
  'forced-restart': '🔁 server force restarted',
  'recovered': '🟢 server recovered',
  'rss': '🔴 server over its memory limit',
  'host': '🟠 host warning',
  'host-recovered': '🟢 host recovered',
}

/**
 * Fans supervision events out to notification transports.
 *
 * Telegram is the only transport so far. The bot token never leaves the secrets
 * file, and every send is rate-limited per server *and* reason so a flapping
 * server cannot flood the chat.
 */
export class NotificationService {
  private readonly cooldowns = new Map<string, number>()
  private lastResult: string | null = null
  private lastResultAt: number | null = null

  constructor(
    private readonly secrets: SecretsStore,
    private readonly getConfig: () => NotificationsConfig,
    private readonly getLogsConfig: () => LogsConfig,
  ) {}

  get telegramTokenSet(): boolean {
    return this.secrets.telegramTokenSet
  }

  status(): TelegramStatus {
    const telegram = this.getConfig().telegram
    return {
      enabled: telegram.enabled,
      tokenSet: this.secrets.telegramTokenSet,
      chatId: telegram.chatId,
      onCrash: telegram.onCrash,
      onUnhealthy: telegram.onUnhealthy,
      onForcedRestart: telegram.onForcedRestart,
      onRecovered: telegram.onRecovered,
      onHost: telegram.onHost,
      cooldownMs: telegram.cooldownMs,
      lastResult: this.lastResult,
      lastResultAt: this.lastResultAt,
    }
  }

  /** Enabled for this reason *and* outside its cooldown window. */
  shouldNotify(event: NotificationEvent, now = Date.now()): boolean {
    const telegram = this.getConfig().telegram
    if (!telegram.enabled)
      return false

    const reasonEnabled = {
      'crash': telegram.onCrash,
      'unhealthy': telegram.onUnhealthy,
      'forced-restart': telegram.onForcedRestart,
      'recovered': telegram.onRecovered,
      'rss': telegram.onCrash,
      'host': telegram.onHost,
      'host-recovered': telegram.onHost,
    }[event.reason]
    if (!reasonEnabled)
      return false

    const until = this.cooldowns.get(`${event.serverId}:${event.reason}`) ?? 0
    return !(telegram.cooldownMs > 0 && until > now)
  }

  /** Starts the cooldown window for this event, so a flapping server stays quiet. */
  markSent(event: NotificationEvent, now = Date.now()): void {
    this.cooldowns.set(`${event.serverId}:${event.reason}`, now + this.getConfig().telegram.cooldownMs)
  }

  /** Fire-and-forget by design: supervision must never wait on a chat API. */
  notify(event: NotificationEvent): void {
    void this.dispatch(event).catch((error: unknown) => {
      logger.warn(`notification failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  async dispatch(event: NotificationEvent): Promise<boolean> {
    // `shouldNotify` owns the toggles and the cooldown, so the policy lives once.
    if (!this.shouldNotify(event))
      return false
    this.markSent(event)

    return this.sendTelegram(
      formatTelegramMessage(TITLE[event.reason], [
        `${event.label} (${event.serverId}) ${REASON_LABEL[event.reason]}`,
        event.detail,
      ]),
    )
  }

  /** Used by the "send test" button in settings. */
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
      formatTelegramMessage('✅ home-hosted-2 test', ['notifications are wired up correctly']),
    )
    this.remember(result.ok ? 'test message sent' : result.error ?? 'test failed')
    return result
  }

  async detectChats(overrides: { botToken?: string } = {}): Promise<{ ok: boolean, chats: Array<{ id: number | string, title: string }>, error?: string }> {
    const token = this.resolveToken(overrides.botToken)
    if (token === null)
      return { ok: false, chats: [], error: 'no bot token configured' }

    const result = await listTelegramChats(token)
    this.remember(result.ok ? `${result.chats.length} chat(s) found` : result.error ?? 'detect failed')
    return result
  }

  /** Verifies a token without sending anything. */
  async verifyToken(token: string): Promise<{ ok: boolean, username?: string, error?: string }> {
    return verifyTelegramToken(token)
  }

  private resolveToken(tokenOverride?: string): string | null {
    const token = tokenOverride?.trim() ?? this.secrets.telegramToken ?? ''
    return token.length > 0 ? token : null
  }

  private async sendTelegram(html: string): Promise<boolean> {
    const telegram = this.getConfig().telegram
    if (telegram.chatId.length === 0) {
      this.remember('no chat id configured')
      return false
    }

    const token = this.resolveToken()
    if (token === null) {
      this.remember('no bot token configured')
      return false
    }

    const result = await sendTelegramMessage(token, telegram.chatId, html)
    this.remember(result.ok ? 'sent' : result.error ?? 'send failed')
    return result.ok
  }

  private remember(message: string): void {
    this.lastResult = message
    this.lastResultAt = Date.now()
  }
}
