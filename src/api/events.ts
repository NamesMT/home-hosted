import type { AppDeps } from '#src/app'
import type { SseMessage } from '#src/shared/contracts'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { streamSSE } from 'hono/streaming'
import { appFactory } from '#src/helpers/factory'
import { validate } from '#src/helpers/validator'
import { serverKey } from '#src/services/events'

const MAX_PENDING_WRITES = 200
const PING_INTERVAL_MS = 15000

const eventsQuery = type({
  /** Only this server's frames. */
  'serverId?': 'string',
  /** The workspace that server belongs to; without it a repeated id matches every workspace. */
  'workspace?': 'string',
  /** `logs=0` drops log frames; the first frame is always the full state. */
  'logs?': 'string',
})

/**
 * One SSE stream per subscriber. Pass `?workspace=<id>&serverId=<id>` to receive
 * only that server's messages; the first frame always carries the full state
 * snapshot.
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
        const logOnly = query.logs !== '0'

        return streamSSE(c, async (stream) => {
          let pending = 0
          let queue: Promise<void> = Promise.resolve()
          let closed = false

          const send = (message: SseMessage): Promise<void> => {
            if (closed)
              return queue
            // A chatty child must not grow the queue without bound; state frames are
            // always kept, log frames are dropped once the client falls behind.
            if (message.type === 'log' && pending > MAX_PENDING_WRITES)
              return queue
            pending += 1
            queue = queue
              .then(() => stream.writeSSE({ event: message.type, data: JSON.stringify(message) }))
              .catch(() => {
                closed = true
              })
              .finally(() => {
                pending -= 1
              })
            return queue
          }

          // A named workspace scopes the subscription to one `workspaceId/serverId`;
          // a bare id keeps working but can only be filtered, because the same id may
          // exist in several workspaces.
          const subscription = workspaceId !== null && serverId !== null
            ? serverKey(workspaceId, serverId)
            : null
          const unsubscribe = deps.hub.subscribe(subscription, (message) => {
            if (!logOnly && message.type === 'log')
              return
            if (subscription === null && serverId !== null && message.serverId !== serverId)
              return
            void send(message)
          })

          stream.onAbort(() => {
            closed = true
            unsubscribe()
          })

          await send({ type: 'hello', ts: Date.now(), state: deps.panel.getState() })

          while (true) {
            await stream.sleep(PING_INTERVAL_MS)
            if (closed)
              break
            await stream.writeSSE({ event: 'ping', data: String(Date.now()) })
          }
        })
      },
    )
}
