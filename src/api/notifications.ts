import type { AppDeps } from '#src/app'
import { DetailedError } from '@namesmt/utils'
import { describeRoute } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { requireWorkspace, workspaceQuerySchema } from '#src/helpers/workspace'
import { forgetBots } from '#src/providers/telegram'
import { deliveryResultSchema, destinationIdParamSchema, destinationTestSchema, notificationActionSchema, okResponseSchema, telegramChatsSchema, telegramTokenSchema } from '#src/shared/contracts'

/**
 * A destination's credential is written straight to a workspace's secrets file and never into a
 * servers config, so notification *policy* and the *credential* stay separate.
 *
 * Notifications belong to a workspace, and every route is scoped to one. The token is keyed by the
 * **destination id**, which is what lets a workspace point at more than one Telegram chat.
 */
export function createNotificationsRoute(deps: AppDeps) {
  const runtimeFor = (workspace: string | undefined) =>
    requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), workspace)

  return appFactory.createApp()
    .put(
      '/notifications/destinations/:id/token',
      describeRoute({
        tags: ['notifications'],
        summary: 'Store a Telegram destination\'s bot token (verified first)',
        responses: { 200: { description: 'Stored', content: jsonBody(okResponseSchema) }, 400: ERROR_RESPONSES[400] },
      }),
      validate('query', workspaceQuerySchema),
      validate('param', destinationIdParamSchema),
      validate('json', telegramTokenSchema),
      async (c) => {
        const runtime = runtimeFor(c.req.valid('query').workspace)
        const id = c.req.valid('param').id
        const { botToken } = c.req.valid('json')
        const verified = await runtime.notifications.verifyToken(botToken)
        if (!verified.ok)
          throw new DetailedError(`telegram rejected the token: ${verified.error ?? 'unknown error'}`, { statusCode: 400, code: 'TELEGRAM_TOKEN_REJECTED' })

        runtime.secrets.setTelegramToken(id, botToken)
        forgetBots()
        return c.json({ ok: true, username: verified.username ?? null })
      },
    )

    .delete(
      '/notifications/destinations/:id/token',
      describeRoute({
        tags: ['notifications'],
        summary: 'Forget a Telegram destination\'s bot token',
        responses: { 200: { description: 'Removed', content: jsonBody(okResponseSchema) } },
      }),
      validate('query', workspaceQuerySchema),
      validate('param', destinationIdParamSchema),
      (c) => {
        const runtime = runtimeFor(c.req.valid('query').workspace)
        runtime.secrets.setTelegramToken(c.req.valid('param').id, null)
        forgetBots()
        return c.json({ ok: true })
      },
    )

    .post(
      '/notifications/destinations/:id/test',
      describeRoute({
        tags: ['notifications'],
        summary: 'Send a test message to one destination',
        responses: { 200: { description: 'Sent or refused', content: jsonBody(deliveryResultSchema) }, 400: ERROR_RESPONSES[400] },
      }),
      validate('query', workspaceQuerySchema),
      validate('param', destinationIdParamSchema),
      validate('json', notificationActionSchema),
      async (c) => {
        const runtime = runtimeFor(c.req.valid('query').workspace)
        const id = c.req.valid('param').id
        /*
         * The code names the *transport*, because one route serves both kinds and a client
         * branching on it was told `TELEGRAM_SEND_FAILED` for a webhook. Measured on a webhook
         * destination whose receiver was down: `{"message":"fetch failed","code":"TELEGRAM_SEND_FAILED"}`.
         * `test-webhook` (the draft route) already answers `WEBHOOK_SEND_FAILED`, so the same
         * failure had two names depending on which one the page called. An id that does not exist
         * keeps the Telegram wording, which is what `sendTest` itself answers ("no such
         * destination") — there is no kind to read.
         */
        const kind = runtime.notifications.destinations().find(destination => destination.id === id)?.kind
        const result = await runtime.notifications.sendTest(id, c.req.valid('json'))
        if (!result.ok) {
          throw new DetailedError(result.error ?? 'the test message failed', {
            statusCode: 400,
            code: kind === 'webhook' ? 'WEBHOOK_SEND_FAILED' : 'TELEGRAM_SEND_FAILED',
          })
        }
        return c.json(result)
      },
    )

    /**
     * Tests a webhook the page has **not saved yet**.
     *
     * The target travels whole, so a URL and its headers can be tried before they are stored — and
     * so a destination's own button tests that destination rather than the first in the list.
     */
    .post(
      '/notifications/test-webhook',
      describeRoute({
        tags: ['notifications'],
        summary: 'Send a test to one webhook destination',
        responses: { 200: { description: 'Sent or refused', content: jsonBody(deliveryResultSchema) }, 400: ERROR_RESPONSES[400] },
      }),
      validate('query', workspaceQuerySchema),
      validate('json', destinationTestSchema),
      async (c) => {
        const runtime = runtimeFor(c.req.valid('query').workspace)
        const { target, id } = c.req.valid('json')
        const result = await runtime.notifications.testWebhook(target, id)
        if (!result.ok)
          throw new DetailedError(result.error ?? 'the test message failed', { statusCode: 400, code: 'WEBHOOK_SEND_FAILED' })
        return c.json(result)
      },
    )

    .post(
      '/notifications/destinations/:id/detect-chats',
      describeRoute({
        tags: ['notifications'],
        summary: 'List the chats a Telegram destination\'s bot can see',
        responses: {
          200: { description: 'Chats', content: jsonBody(telegramChatsSchema) },
          400: ERROR_RESPONSES[400],
        },
      }),
      validate('query', workspaceQuerySchema),
      validate('param', destinationIdParamSchema),
      validate('json', notificationActionSchema),
      async (c) => {
        const runtime = runtimeFor(c.req.valid('query').workspace)
        const result = await runtime.notifications.detectChats(c.req.valid('param').id, c.req.valid('json'))
        if (!result.ok)
          throw new DetailedError(result.error ?? 'could not list chats', { statusCode: 400, code: 'TELEGRAM_LIST_FAILED' })
        return c.json({ chats: result.chats })
      },
    )
}
