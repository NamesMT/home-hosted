import type { TelegramBot as Bot } from '#src/providers/telegram'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeTelegramError,
  escapeHtml,
  forgetBots,
  formatTelegramMessage,
  getBot,
  listTelegramChats,
  sendTelegramMessage,
  verifyTelegramToken,
} from '#src/providers/telegram'

const TOKEN = '123456:telegram-test-token'
const OTHER_TOKEN = '654321:other-test-token'

// A stubbed client must never leak into the next test.
afterEach(() => {
  forgetBots()
})

/**
 * The bot is outbound-only, so replacing one cached API method is the whole
 * network seam: the real client is still built and its options are still the
 * ones the provider passes.
 */
function stubApi(bot: Bot, method: string, impl: (...args: unknown[]) => unknown): void {
  const api = bot.api as unknown as Record<string, unknown>
  api[method] = impl
}

describe('escapeHtml', () => {
  it('escapes ampersands, less-than and greater-than', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })

  it('escapes each character exactly once and leaves quotes alone', () => {
    // `<` becomes `&lt;`, not `&amp;lt;`: the ampersand pass already ran.
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;')
    expect(escapeHtml('"double" and \'single\'')).toBe('"double" and \'single\'')
    expect(escapeHtml('')).toBe('')
  })
})

describe('formatTelegramMessage', () => {
  it('wraps the title in bold and adds no trailing newline without a body', () => {
    expect(formatTelegramMessage('server down', [])).toBe('<b>server down</b>')
    expect(formatTelegramMessage('server down', ['', ''])).toBe('<b>server down</b>')
  })

  it('renders one bullet per kept line', () => {
    expect(formatTelegramMessage('t', ['first', '', 'second'])).toBe('<b>t</b>\n• first\n• second')
  })

  it('keeps a whitespace-only line and escapes html in the body and the title', () => {
    // The filter only drops truly empty strings; whitespace survives.
    expect(formatTelegramMessage('<t>', ['  ', 'a & <b>'])).toBe('<b>&lt;t&gt;</b>\n•   \n• a &amp; &lt;b&gt;')
  })
})

describe('describeTelegramError', () => {
  it('unwraps a grammY error with its code and retry hint', () => {
    expect(describeTelegramError({
      error_code: 429,
      description: 'Too Many Requests: retry later',
      parameters: { retry_after: 7 },
    })).toBe('Too Many Requests: retry later (429), retry in 7s')
  })

  it('omits the code when grammY did not supply one', () => {
    expect(describeTelegramError({ description: 'Bad Request: chat not found' })).toBe('Bad Request: chat not found')
  })

  it('appends only the code when there is no retry hint', () => {
    expect(describeTelegramError({ error_code: 403, description: 'Forbidden: bot was blocked' })).toBe('Forbidden: bot was blocked (403)')
  })

  it('falls back from description to message', () => {
    expect(describeTelegramError({ error_code: 500, message: 'Internal Server Error' })).toBe('Internal Server Error (500)')
  })

  it('unwraps a plain Error', () => {
    expect(describeTelegramError(new Error('connection reset'))).toBe('connection reset')
  })

  it('stringifies anything that is not an error object', () => {
    expect(describeTelegramError('plain string')).toBe('plain string')
    expect(describeTelegramError(42)).toBe('42')
    expect(describeTelegramError(null)).toBe('null')
    expect(describeTelegramError(undefined)).toBe('undefined')
    expect(describeTelegramError({})).toBe('[object Object]')
  })
})

describe('getBot', () => {
  it('caches one client per token', () => {
    const first = getBot(TOKEN)
    expect(getBot(TOKEN)).toBe(first)
    expect(getBot(OTHER_TOKEN)).not.toBe(first)
  })

  it('hands out a fresh client once the cache is dropped', () => {
    const first = getBot(TOKEN)
    forgetBots()
    expect(getBot(TOKEN)).not.toBe(first)
  })
})

describe('sendTelegramMessage', () => {
  it('sends html through the cached bot and reports success', async () => {
    const calls: unknown[][] = []
    stubApi(getBot(TOKEN), 'sendMessage', (...args) => {
      calls.push(args)
      return Promise.resolve({ ok: true })
    })

    expect(await sendTelegramMessage(TOKEN, '42', '<b>hi</b>')).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('42')
    expect(calls[0]![1]).toBe('<b>hi</b>')
    expect(calls[0]![2]).toEqual({ parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
  })

  it('reports a telegram failure as an outcome instead of throwing', async () => {
    stubApi(getBot(TOKEN), 'sendMessage', () => {
      // grammY rejects with a plain object, so the shape is the thing under test.
      // eslint-disable-next-line no-throw-literal
      throw { error_code: 403, description: 'Forbidden: bot was blocked by the user' }
    })

    expect(await sendTelegramMessage(TOKEN, '42', 'hi')).toEqual({
      ok: false,
      error: 'Forbidden: bot was blocked by the user (403)',
    })
  })
})

describe('verifyTelegramToken', () => {
  it('returns the username telegram reports', async () => {
    stubApi(getBot(TOKEN), 'getMe', () => Promise.resolve({ id: 1, is_bot: true, first_name: 'HH', username: 'hh_bot' }))
    expect(await verifyTelegramToken(TOKEN)).toEqual({ ok: true, username: 'hh_bot' })
  })

  it('returns the failure message', async () => {
    stubApi(getBot(TOKEN), 'getMe', () => {
      throw new Error('Unauthorized')
    })
    expect(await verifyTelegramToken(TOKEN)).toEqual({ ok: false, error: 'Unauthorized' })
  })
})

describe('listTelegramChats', () => {
  it('asks for the three chat-carrying update kinds', async () => {
    const calls: unknown[] = []
    stubApi(getBot(TOKEN), 'getUpdates', (options) => {
      calls.push(options)
      return Promise.resolve([])
    })

    expect(await listTelegramChats(TOKEN)).toEqual({ ok: true, chats: [] })
    expect(calls[0]).toEqual({ limit: 100, allowed_updates: ['message', 'channel_post', 'edited_message'] })
  })

  it('deduplicates by chat id and applies every title fallback', async () => {
    stubApi(getBot(TOKEN), 'getUpdates', () => Promise.resolve([
      { update_id: 1, message: { chat: { id: 10, title: 'Group A' } } },
      { update_id: 2, message: { chat: { id: 10, title: 'Group A' } } },
      { update_id: 3, channel_post: { chat: { id: 11, username: 'channel_handle' } } },
      { update_id: 4, edited_message: { chat: { id: 12, first_name: 'Ada' } } },
      { update_id: 5, message: { chat: { id: 13 } } },
      { update_id: 6 },
    ]))

    const result = await listTelegramChats(TOKEN)
    expect(result.ok).toBe(true)
    expect(result.chats).toEqual([
      { id: 10, title: 'Group A' },
      { id: 11, title: '@channel_handle' },
      { id: 12, title: 'Ada' },
      { id: 13, title: 'private chat' },
    ])
  })

  it('prefers a title over a username on the same chat', async () => {
    stubApi(getBot(TOKEN), 'getUpdates', () => Promise.resolve([
      { update_id: 1, message: { chat: { id: 7, title: 'Named', username: 'handle' } } },
    ]))
    expect(await listTelegramChats(TOKEN)).toEqual({ ok: true, chats: [{ id: 7, title: 'Named' }] })
  })

  it('reports a failure with no chats at all', async () => {
    stubApi(getBot(TOKEN), 'getUpdates', () => {
      // eslint-disable-next-line no-throw-literal
      throw { error_code: 401, description: 'Unauthorized' }
    })

    expect(await listTelegramChats(TOKEN)).toEqual({ ok: false, chats: [], error: 'Unauthorized (401)' })
  })
})

describe('the Bot API client', () => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('posts to the method with the token in the path, and returns the result', async () => {
    const calls: Array<{ url: string, body: unknown }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      return reply(200, { ok: true, result: { id: 1, is_bot: true, first_name: 'HH', username: 'hh_bot' } })
    })
    expect(await verifyTelegramToken(TOKEN)).toEqual({ ok: true, username: 'hh_bot' })
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`)
  })

  it('waits out a 429 retry_after, then succeeds', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return calls === 1
        ? reply(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } })
        : reply(200, { ok: true, result: true })
    })
    const sent = sendTelegramMessage(TOKEN, '42', 'hi')
    await vi.advanceTimersByTimeAsync(3000)
    expect(await sent).toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  it('does not retry a refusal, and names it', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return reply(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' })
    })
    expect(await sendTelegramMessage(TOKEN, '42', 'hi')).toEqual({ ok: false, error: 'Bad Request: chat not found (400)' })
    expect(calls).toBe(1)
  })

  it('never puts the token in a network error it reports', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`)
    })
    const sent = sendTelegramMessage(TOKEN, '42', 'hi')
    await vi.advanceTimersByTimeAsync(10_000)
    const outcome = await sent
    expect(outcome.ok).toBe(false)
    expect(outcome.error).not.toContain(TOKEN)
    expect(outcome.error).toContain('could not reach Telegram')
  })
})
