import type { AppDeps } from '#src/app'
import type { SseMessage } from '#src/shared/contracts'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { streamSSE } from 'hono/streaming'
import { appFactory } from '#src/helpers/factory'
import { frameKey, sseChannel } from '#src/helpers/sse'
import { validate } from '#src/helpers/validator'
import { serverKey } from '#src/services/events'

const PING_INTERVAL_MS = 15000

const eventsQuery = type({
  /** Only this server's frames. */
  'serverId?': 'string',
  /** Only this workspace's server and log frames. */
  'workspace?': 'string',
  /** `logs=0` drops log frames; the first frame is always the full state. */
  'logs?': 'string',
}).onUndeclaredKey('reject')

/**
 * One SSE stream per subscriber. `?workspace=<id>` narrows server and log frames to one workspace,
 * `&serverId=<id>` to one server; the first frame always carries the full state snapshot.
 */
export function createEventsRoute(deps: AppDeps) {
  return appFactory.createApp()
    .get(
      '/events',
      describeRoute({
        tags: ['panel'],
        summary: 'Panel state and log frames as server-sent events',
        responses: { 200: { description: 'text/event-stream' } },
      }),
      validate('query', eventsQuery),
      (c) => {
        const query = c.req.valid('query')
        const serverId = query.serverId ?? null
        const workspaceId = query.workspace ?? null
        const includeLogs = query.logs !== '0'

        return streamSSE(c, async (stream) => {
          const channel = sseChannel(stream)
          const send = (message: SseMessage): void => {
            channel.send(message.type, JSON.stringify(message), { key: frameKey(message), droppable: message.type === 'log' })
          }

          // A named workspace scopes the subscription to one `workspaceId/serverId`;
          // a bare id keeps working but can only be filtered, because the same id may
          // exist in several workspaces.
          const subscription = workspaceId !== null && serverId !== null
            ? serverKey(workspaceId, serverId)
            : null
          const unsubscribe = deps.hub.subscribe(subscription, (message) => {
            if (!includeLogs && message.type === 'log')
              return
            // A state frame carries no server, so a single-server subscription skips it too.
            if (subscription === null && serverId !== null && (!('serverId' in message) || message.serverId !== serverId))
              return
            // `?workspace=` alone narrows server and log frames; state frames are panel-wide.
            if (subscription === null && workspaceId !== null && 'workspaceId' in message && message.workspaceId !== workspaceId)
              return
            send(message)
          })

          stream.onAbort(() => {
            channel.close()
            unsubscribe()
          })

          send({ type: 'hello', ts: Date.now(), state: deps.panel.getState() })

          while (!channel.closed) {
            await stream.sleep(PING_INTERVAL_MS)
            channel.send('ping', String(Date.now()), { key: 'ping' })
          }
        })
      },
    )
}
