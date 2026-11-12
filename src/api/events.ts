import type { AppDeps } from '#src/app'
import type { SseMessage } from '#src/shared/contracts'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { unknownServerError } from '#src/helpers/action-result'
import { serveEventStream } from '#src/helpers/event-stream'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { requireWorkspace } from '#src/helpers/workspace'
import { serverKey } from '#src/services/events'
import { lazy } from '#src/shared/lazy'
import { booleanParam } from '#src/shared/query-params'

const eventsQuery = lazy(() => type({
  /** Only this server's frames — in `workspace`, or the default workspace when that is omitted. */
  'serverId?': 'string',
  /** Only this workspace's server and log frames. */
  'workspace?': 'string',
  /** `logs=0`/`false` drops log frames; the first frame is always the full state. */
  'logs?': booleanParam,
}).onUndeclaredKey('reject'))

/**
 * One SSE stream per subscriber. `?workspace=<id>` narrows server and log frames to one workspace,
 * `&serverId=<id>` to one server of it (of the default workspace when none is named); the first frame
 * always carries the full state snapshot.
 *
 * **Unknown ids are refused before the stream opens.** Both used to answer `200` and stream nothing:
 * a mistyped workspace id was silently subscribed to a key nothing publishes under, and a mistyped
 * server id with no workspace skipped the lookup entirely. A client reads silence as "nothing is
 * happening", which is the one thing a live stream must never say when its target does not exist.
 */
export function createEventsRoute(deps: AppDeps) {
  return appFactory.createApp()
    .get(
      '/events',
      describeRoute({
        tags: ['panel'],
        summary: 'Panel state and log frames as server-sent events',
        responses: { 200: { description: 'text/event-stream' }, 404: ERROR_RESPONSES[404] },
      }),
      validate('query', eventsQuery),
      (c) => {
        const query = c.req.valid('query')
        const serverId = query.serverId ?? null
        const includeLogs = query.logs !== false

        // A server id is unique only inside its workspace, so naming one without a workspace means
        // the default workspace — the rule every other workspace-scoped route follows — never "any".
        // The lookup runs whenever either is named, so both a bad workspace and a bad server 404.
        const runtime = serverId === null && query.workspace === undefined
          ? null
          : requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), query.workspace)
        const workspaceId = runtime?.id ?? null
        if (serverId !== null && runtime !== null && !runtime.store.getServer(serverId))
          throw unknownServerError(serverId)

        return serveEventStream(c, deps.auth, (send) => {
          const subscription = workspaceId !== null && serverId !== null ? serverKey(workspaceId, serverId) : null
          const unsubscribe = deps.hub.subscribe(subscription, (message) => {
            if (!includeLogs && message.type === 'log')
              return
            // `?workspace=` alone narrows server and log frames; state frames are panel-wide.
            if (subscription === null && workspaceId !== null && 'workspaceId' in message && message.workspaceId !== workspaceId)
              return
            send(message)
          })
          const hello: SseMessage = { type: 'hello', ts: Date.now(), state: deps.panel.getState() }
          send(hello)
          return unsubscribe
        })
      },
    )
}
