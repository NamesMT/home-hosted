import type { NotificationEvent } from '#src/services/notifications'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type } from 'arktype'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretsStore } from '#src/config/secrets'
import { formatTelegramMessage } from '#src/providers/telegram'
import { NotificationService } from '#src/services/notifications'
import { logsSchema, notificationsSchema } from '#src/shared/contracts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function makeService(options: {
  telegram?: Record<string, unknown>
  token?: string
} = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh2-notify-'))
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
