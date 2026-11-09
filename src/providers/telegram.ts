import { errorMessage } from '#src/shared/error-message'

/**
 * The three Bot API calls notifications make, over the built-in `fetch`.
 *
 * A retrying client: a 429 waits its `retry_after` (when that is at most 20 s), a 5xx or a network
 * failure backs off 1 s, 2 s, 4 s, and every attempt is bounded at 10 s, so a caller gets a result
 * or a real error, never a hang.
 */
const API_BASE = 'https://api.telegram.org'
const ATTEMPTS = 4
const REQUEST_TIMEOUT_MS = 10_000
const MAX_RETRY_AFTER_S = 20

/** A Bot API refusal, shaped like Telegram's own error body so `describeTelegramError` reads it. */
export class TelegramApiError extends Error {
  override name = 'TelegramApiError'
  constructor(readonly description: string, readonly error_code: number, readonly parameters?: { retry_after?: number }) {
    super(description)
  }
}

interface ApiEnvelope<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
}

export interface TelegramUser { id: number, is_bot: boolean, first_name: string, username?: string }
export interface TelegramChatRef { id: number, type: string, title?: string, username?: string, first_name?: string }
export interface TelegramUpdate {
  update_id: number
  message?: { chat: TelegramChatRef }
  channel_post?: { chat: TelegramChatRef }
  edited_message?: { chat: TelegramChatRef }
}

export interface TelegramBot {
  api: {
    sendMessage: (chatId: string, text: string, options?: Record<string, unknown>) => Promise<unknown>
    getMe: () => Promise<TelegramUser>
    getUpdates: (options?: Record<string, unknown>) => Promise<TelegramUpdate[]>
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function callApi<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let envelope: ApiEnvelope<T> | null = null
    try {
      const response = await fetch(`${API_BASE}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      envelope = await response.json() as ApiEnvelope<T>
      if (envelope.ok)
        return envelope.result as T
      lastError = new TelegramApiError(envelope.description ?? `Telegram answered ${response.status}`, envelope.error_code ?? response.status, envelope.parameters)
    }
    catch (error) {
      // A network failure or timeout: worth another try. The token is in the URL, so the message is
      // rebuilt rather than passed through (fetch errors can quote the URL).
      lastError = new Error(`could not reach Telegram: ${error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : errorMessage(error).replaceAll(token, '<token>')}`)
    }

    const code = envelope?.error_code
    const retryAfter = envelope?.parameters?.retry_after
    const transient = envelope === null || code === 429 || (code !== undefined && code >= 500)
    if (!transient || attempt === ATTEMPTS - 1)
      break
    if (code === 429 && retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S)
      break
    await sleep(code === 429 && retryAfter !== undefined ? retryAfter * 1000 : 1000 * 2 ** attempt)
  }
  throw lastError
}

const bots = new Map<string, TelegramBot>()

export function getBot(token: string): TelegramBot {
  const cached = bots.get(token)
  if (cached)
    return cached
  const bot: TelegramBot = {
    api: {
      sendMessage: (chatId, text, options = {}) => callApi(token, 'sendMessage', { chat_id: chatId, text, ...options }),
      getMe: () => callApi<TelegramUser>(token, 'getMe', {}),
      getUpdates: (options = {}) => callApi<TelegramUpdate[]>(token, 'getUpdates', options),
    },
  }
  bots.set(token, bot)
  return bot
}

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
  return errorMessage(error)
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
