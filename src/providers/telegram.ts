import type { Bot } from 'grammy'
import { autoRetry } from '@grammyjs/auto-retry'
import { Bot as GrammyBot } from 'grammy'

/**
 * Telegram Bot API access, built on grammY.
 *
 * grammY is used for what it is good at — a typed, retrying, extensible Bot API
 * client — while the bot itself stays outbound-only for now. If inbound commands
 * or a webhook are ever wanted, the same instance can host handlers without
 * touching the notification code.
 *
 * `autoRetry` handles Telegram's 429 `retry_after` (and other transient failures)
 * so callers get either a result or a real error.
 */

const bots = new Map<string, Bot>()

export function getBot(token: string): Bot {
  const cached = bots.get(token)
  if (cached)
    return cached

  const bot = new GrammyBot(token, { client: { timeoutSeconds: 10 } })
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 20 }))
  bots.set(token, bot)
  return bot
}

/** Drops cached clients; used when the token changes or the service shuts down. */
export function forgetBots(): void {
  bots.clear()
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function formatTelegramMessage(title: string, lines: string[]): string {
  const body = lines.filter(line => line.length > 0).map(line => `• ${escapeHtml(line)}`).join('\n')
  return `<b>${escapeHtml(title)}</b>${body.length > 0 ? `\n${body}` : ''}`
}

export interface TelegramOutcome {
  ok: boolean
  error?: string
}

/** Turns a grammY error into something worth showing in the settings page. */
export function describeTelegramError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { error_code?: number, description?: string, message?: string, parameters?: { retry_after?: number } }
    const description = candidate.description ?? candidate.message
    if (description) {
      const code = candidate.error_code === undefined ? '' : ` (${candidate.error_code})`
      const retry = candidate.parameters?.retry_after === undefined ? '' : `, retry in ${candidate.parameters.retry_after}s`
      return `${description}${code}${retry}`
    }
  }
  return error instanceof Error ? error.message : String(error)
}

export async function sendTelegramMessage(token: string, chatId: string, html: string): Promise<TelegramOutcome> {
  try {
    await getBot(token).api.sendMessage(chatId, html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })
    return { ok: true }
  }
  catch (error) {
    return { ok: false, error: describeTelegramError(error) }
  }
}

export async function verifyTelegramToken(token: string): Promise<{ ok: boolean, username?: string, error?: string }> {
  try {
    const me = await getBot(token).api.getMe()
    return { ok: true, username: me.username }
  }
  catch (error) {
    return { ok: false, error: describeTelegramError(error) }
  }
}

export interface TelegramChat {
  id: number | string
  title: string
}

/**
 * Recent chats that talked to the bot, so a chat id can be picked instead of
 * hunted down by hand. Telegram only reports chats with pending updates, so the
 * caller is told to message the bot first.
 */
export async function listTelegramChats(token: string): Promise<{ ok: boolean, chats: TelegramChat[], error?: string }> {
  try {
    const updates = await getBot(token).api.getUpdates({
      limit: 100,
      allowed_updates: ['message', 'channel_post', 'edited_message'],
    })

    const chats = new Map<string, TelegramChat>()
    for (const update of updates) {
      const chat = update.message?.chat ?? update.channel_post?.chat ?? update.edited_message?.chat
      if (!chat)
        continue
      const title = 'title' in chat && chat.title
        ? chat.title
        : 'username' in chat && chat.username
          ? `@${chat.username}`
          : 'first_name' in chat && chat.first_name
            ? chat.first_name
            : 'private chat'
      chats.set(String(chat.id), { id: chat.id, title })
    }

    return { ok: true, chats: [...chats.values()] }
  }
  catch (error) {
    return { ok: false, chats: [], error: describeTelegramError(error) }
  }
}
