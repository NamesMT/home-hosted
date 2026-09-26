import type { NotificationEvent, NotificationReason } from '#src/services/notifications'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type } from 'arktype'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretsStore } from '#src/config/secrets'
import { forgetBots, formatTelegramMessage, getBot } from '#src/providers/telegram'
import { NotificationService } from '#src/services/notifications'
import { logsSchema, notificationsSchema } from '#src/shared/contracts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

// A stubbed telegram client must never leak into the next test.
afterEach(() => {
  forgetBots()
})

const BOT_TOKEN = '123456:notification-test-token'
const OVERRIDE_TOKEN = '654321:override-test-token'

/** Replaces one cached bot API method: the only seam this service has. */
function stubApi(token: string, method: string, impl: (...args: unknown[]) => unknown): void {
  const api = getBot(token).api as unknown as Record<string, unknown>
  api[method] = impl
}

/** Lets a fire-and-forget `notify()` settle without depending on timing. */
function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

async function makeService(options: {
  telegram?: Record<string, unknown>
  token?: string
} = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-notify-'))
  dirs.push(dir)

  const notifications = notificationsSchema({ telegram: options.telegram ?? {} })
  if (notifications instanceof type.errors)
    throw new Error(notifications.summary)
  const logs = logsSchema({})
  if (logs instanceof type.errors)
    throw new Error(logs.summary)

  const secrets = new SecretsStore(path.join(dir, 'secrets.json'))
  if (options.token !== undefined)
    secrets.setTelegramToken(options.token)

  return new NotificationService(secrets, () => notifications, () => logs)
}

const crash: NotificationEvent = { serverId: 'web', label: 'Web', reason: 'crash', detail: 'gave up' }

describe('notification policy', () => {
  it('stays silent while notifications are switched off', async () => {
    const service = await makeService({ telegram: { enabled: false, chatId: '1' }, token: 'token' })
    expect(service.shouldNotify(crash)).toBe(false)
    expect(await service.dispatch(crash)).toBe(false)
  })

  it('respects the per-reason toggles', async () => {
    const service = await makeService({ telegram: { enabled: true, chatId: '1', onCrash: false }, token: 'token' })
    expect(service.shouldNotify(crash)).toBe(false)
    expect(service.shouldNotify({ ...crash, reason: 'unhealthy' })).toBe(true)
  })

  it('applies a cooldown per server and reason', async () => {
    const service = await makeService({ telegram: { enabled: true, chatId: '1', cooldownMs: 60000 }, token: 'token' })
    const now = 1_000_000

    expect(service.shouldNotify(crash, now)).toBe(true)
    service.markSent(crash, now)

    expect(service.shouldNotify(crash, now + 1000)).toBe(false)
    expect(service.shouldNotify(crash, now + 61000)).toBe(true)
    // A different reason on the same server is not suppressed.
    expect(service.shouldNotify({ ...crash, reason: 'unhealthy' }, now + 1000)).toBe(true)
    // Nor the same reason on another server.
    expect(service.shouldNotify({ ...crash, serverId: 'api' }, now + 1000)).toBe(true)
  })

  it('reports a missing token or chat id without attempting a send', async () => {
    const noToken = await makeService({ telegram: { enabled: true, chatId: '1' } })
    expect(await noToken.sendTest()).toEqual({ ok: false, error: 'no bot token configured' })

    const noChat = await makeService({ telegram: { enabled: true, chatId: '' }, token: 'token' })
    expect(await noChat.sendTest()).toEqual({ ok: false, error: 'no chat id configured' })
  })

  it('exposes the telegram status without leaking the token', async () => {
    const service = await makeService({ telegram: { enabled: true, chatId: '42' }, token: 'super-secret-token' })
    const status = service.status()
    expect(status.chatId).toBe('42')
    expect(status.tokenSet).toBe(true)
    expect(JSON.stringify(status)).not.toContain('super-secret-token')
  })
})

describe('telegram formatting', () => {
  it('escapes html so a log line cannot break the message', () => {
    const message = formatTelegramMessage('title <script>', ['a & b > c'])
    expect(message).toContain('title &lt;script&gt;')
    expect(message).toContain('a &amp; b &gt; c')
    expect(message).not.toContain('<script>')
  })

  it('skips empty lines', () => {
    expect(formatTelegramMessage('t', ['', 'kept'])).toBe('<b>t</b>\n• kept')
  })
})

describe('reason toggles', () => {
  it('maps every reason onto its own switch', async () => {
    const cases: Array<[NotificationReason, string]> = [
      ['crash', 'onCrash'],
      // A memory limit is a crash by another name, so it follows the crash switch.
      ['rss', 'onCrash'],
      ['unhealthy', 'onUnhealthy'],
      ['forced-restart', 'onForcedRestart'],
      ['recovered', 'onRecovered'],
      ['host', 'onHost'],
      ['host-recovered', 'onHost'],
    ]

    for (const [reason, toggle] of cases) {
      const off = await makeService({ telegram: { enabled: true, chatId: '1', [toggle]: false }, token: BOT_TOKEN })
      expect(off.shouldNotify({ ...crash, reason }), `${reason} with ${toggle} off`).toBe(false)

      const on = await makeService({ telegram: { enabled: true, chatId: '1', [toggle]: true }, token: BOT_TOKEN })
      expect(on.shouldNotify({ ...crash, reason }), `${reason} with ${toggle} on`).toBe(true)
    }
  })

  it('leaves recovery notices opt-in, so a flapping server does not narrate itself', async () => {
    const defaults = await makeService({ telegram: { enabled: true, chatId: '1' }, token: BOT_TOKEN })

    expect(defaults.shouldNotify(crash)).toBe(true)
    expect(defaults.shouldNotify({ ...crash, reason: 'recovered' })).toBe(false)
  })
})

describe('telegram delivery', () => {
  it('reports whether a bot token is stored', async () => {
    expect((await makeService()).telegramTokenSet).toBe(false)
    expect((await makeService({ token: BOT_TOKEN })).telegramTokenSet).toBe(true)
  })

  it('sends an alert once and then suppresses the flap', async () => {
    const service = await makeService({ telegram: { enabled: true, chatId: '42', cooldownMs: 60_000 }, token: BOT_TOKEN })
    const sent: unknown[][] = []
    stubApi(BOT_TOKEN, 'sendMessage', (...args) => {
      sent.push(args)
      return Promise.resolve({ ok: true })
    })

    expect(await service.dispatch(crash)).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]![0]).toBe('42')
    expect(sent[0]![1]).toContain('server down')
    expect(sent[0]![1]).toContain('Web (web) gave up restarting')
    expect(service.status().lastResult).toBe('sent')

    // The same server crashing again inside the cooldown stays quiet.
    expect(await service.dispatch(crash)).toBe(false)
    expect(sent).toHaveLength(1)
  })

  it('records why a delivery was refused instead of pretending it was sent', async () => {
    const noChat = await makeService({ telegram: { enabled: true, chatId: '' }, token: BOT_TOKEN })
    expect(await noChat.dispatch(crash)).toBe(false)
    expect(noChat.status().lastResult).toBe('no chat id configured')

    const noToken = await makeService({ telegram: { enabled: true, chatId: '42' } })
    expect(await noToken.dispatch(crash)).toBe(false)
    expect(noToken.status().lastResult).toBe('no bot token configured')
  })

  it('records a provider failure rather than throwing at the supervisor', async () => {
    const service = await makeService({ telegram: { enabled: true, chatId: '42' }, token: BOT_TOKEN })
    stubApi(BOT_TOKEN, 'sendMessage', () => {
      // grammY rejects with a plain object, so the shape is the thing under test.
      // eslint-disable-next-line no-throw-literal
      throw { error_code: 403, description: 'bot was blocked by the user' }
    })

    expect(await service.dispatch(crash)).toBe(false)
    expect(service.status().lastResult).toBe('bot was blocked by the user (403)')
  })

  it('never lets a failed fire-and-forget notification reject the caller', async () => {
    const service = await makeService({ telegram: { enabled: true, chatId: '42' }, token: BOT_TOKEN })
    stubApi(BOT_TOKEN, 'sendMessage', () => {
      throw new Error('network down')
    })

    expect(() => service.notify(crash)).not.toThrow()
    await flush()
    expect(service.status().lastResult).toBe('network down')
  })

  it('sends the test message, honouring an override', async () => {
    const service = await makeService({ telegram: { enabled: true, chatId: '42' }, token: BOT_TOKEN })
    const sent: unknown[][] = []
    const record = (...args: unknown[]): Promise<{ ok: boolean }> => {
      sent.push(args)
      return Promise.resolve({ ok: true })
    }
    stubApi(BOT_TOKEN, 'sendMessage', record)
    stubApi(OVERRIDE_TOKEN, 'sendMessage', record)

    expect(await service.sendTest()).toEqual({ ok: true })
    expect(sent[0]![0]).toBe('42')
    expect(sent[0]![1]).toContain('home-hosted test')
    expect(service.status().lastResult).toBe('test message sent')

    expect(await service.sendTest({ chatId: '99', botToken: OVERRIDE_TOKEN })).toEqual({ ok: true })
    expect(sent[1]![0]).toBe('99')
  })

  it('records a refused test message', async () => {
    const service = await makeService({ telegram: { enabled: true, chatId: '42' }, token: BOT_TOKEN })
    stubApi(BOT_TOKEN, 'sendMessage', () => {
      throw new Error('chat not found')
    })

    expect(await service.sendTest()).toEqual({ ok: false, error: 'chat not found' })
    expect(service.status().lastResult).toBe('chat not found')
  })

  it('lists the chats the bot can see, and reports a failure', async () => {
    const service = await makeService({ telegram: { enabled: true, chatId: '42' }, token: BOT_TOKEN })
    stubApi(BOT_TOKEN, 'getUpdates', () => Promise.resolve([
      { update_id: 1, message: { chat: { id: 7, title: 'Group' } } },
    ]))

    expect(await service.detectChats()).toEqual({ ok: true, chats: [{ id: 7, title: 'Group' }] })
    expect(service.status().lastResult).toBe('1 chat(s) found')

    const noToken = await makeService()
    expect(await noToken.detectChats()).toEqual({ ok: false, chats: [], error: 'no bot token configured' })

    stubApi(BOT_TOKEN, 'getUpdates', () => {
      // eslint-disable-next-line no-throw-literal
      throw { error_code: 401, description: 'Unauthorized' }
    })
    expect((await service.detectChats()).ok).toBe(false)
    expect(service.status().lastResult).toBe('Unauthorized (401)')
  })

  it('verifies a token without sending anything', async () => {
    const service = await makeService()
    stubApi(BOT_TOKEN, 'getMe', () => Promise.resolve({ id: 1, is_bot: true, first_name: 'HH', username: 'hh_bot' }))

    expect(await service.verifyToken(BOT_TOKEN)).toEqual({ ok: true, username: 'hh_bot' })
  })
})
