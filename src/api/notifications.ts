import type { AppDeps } from '#src/app'
import { DetailedError } from '@namesmt/utils'
import { describeRoute } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { requireWorkspace, workspaceQuerySchema } from '#src/helpers/workspace'
import { forgetBots } from '#src/providers/telegram'
import { notificationActionSchema, telegramChatsSchema, telegramTokenSchema } from '#src/shared/contracts'

/**
 * The bot token is written straight to a workspace's secrets file and never into a
 * servers config, so notification *policy* and the *credential* stay separate.
 *
 * Notifications belong to a workspace: each one keeps its own token and chat.
 */
export function createNotificationsRoute(deps: AppDeps) {
  return appFactory.createApp()
    .put(
      '/notifications/token',
      describeRoute({
        tags: ['notifications'],
        summary: 'Store the Telegram bot token (verified first)',
        responses: { 200: { description: 'Stored' }, 400: ERROR_RESPONSES[400] },
      }),
      validate('query', workspaceQuerySchema),
      validate('json', telegramTokenSchema),
      async (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { botToken } = c.req.valid('json')
        const verified = await runtime.notifications.verifyToken(botToken)
        if (!verified.ok)
          throw new DetailedError(`telegram rejected the token: ${verified.error ?? 'unknown error'}`, { statusCode: 400, code: 'TELEGRAM_TOKEN_REJECTED' })

        runtime.secrets.setTelegramToken(botToken)
        forgetBots()
        return c.json({ ok: true, username: verified.username ?? null })
      },
    )

    .delete(
      '/notifications/token',
      describeRoute({
        tags: ['notifications'],
        summary: 'Forget the Telegram bot token',
        responses: { 200: { description: 'Removed' } },
      }),
      validate('query', workspaceQuerySchema),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        runtime.secrets.setTelegramToken(null)
        forgetBots()
        return c.json({ ok: true })
      },
    )

    .post(
      '/notifications/test',
      describeRoute({
        tags: ['notifications'],
        summary: 'Send a test message',
        responses: { 200: { description: 'Sent or refused' }, 400: ERROR_RESPONSES[400] },
      }),
      validate('query', workspaceQuerySchema),
      validate('json', notificationActionSchema),
      async (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const result = await runtime.notifications.sendTest(c.req.valid('json'))
        if (!result.ok)
          throw new DetailedError(result.error ?? 'the test message failed', { statusCode: 400, code: 'TELEGRAM_SEND_FAILED' })
        return c.json(result)
      },
    )

    .post(
      '/notifications/detect-chats',
      describeRoute({
        tags: ['notifications'],
        summary: 'List the chats the bot can see',
        responses: {
          200: { description: 'Chats', content: jsonBody(telegramChatsSchema) },
          400: ERROR_RESPONSES[400],
        },
      }),
      validate('query', workspaceQuerySchema),
      validate('json', notificationActionSchema),
      async (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const result = await runtime.notifications.detectChats(c.req.valid('json'))
        if (!result.ok)
          throw new DetailedError(result.error ?? 'could not list chats', { statusCode: 400, code: 'TELEGRAM_LIST_FAILED' })
        return c.json({ chats: result.chats })
      },
    )
}
