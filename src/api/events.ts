import type { AppDeps } from '#src/app'
import type { SseMessage } from '#src/shared/contracts'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { unknownServerError } from '#src/helpers/action-result'
import { resumePoint, serveEventStream } from '#src/helpers/event-stream'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, sseResponse } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { requireWorkspace } from '#src/helpers/workspace'
import { serverKey } from '#src/services/events'
import { lazy } from '#src/shared/lazy'
import { booleanParam, integerParam } from '#src/shared/query-params'

const eventsQuery = lazy(() => type({
  /** Only this server's frames — in `workspace`, or the default workspace when that is omitted. */
  'serverId?': 'string',
  /** Only this workspace's server and log frames. */
  'workspace?': 'string',
  /** `logs=0`/`false` drops log frames; the first frame is always the full state. */
  'logs?': booleanParam,
  /**
   * Resume after this sequence: replay the buffered `log` frames published since it, after one
   * current snapshot. `Last-Event-ID` says the same thing and is what a reconnecting `EventSource`
   * sends by itself; a named `since` wins when both are present. Negative is refused, not clamped.
   */
  'since?': integerParam(0, 9_999_999_999_999),
}).onUndeclaredKey('reject'))

/**
 * One SSE stream per subscriber. `?workspace=<id>` narrows server and log frames to one workspace,
 * `&serverId=<id>` to one server of it (of the default workspace when none is named); the first frame
 * always carries the full state snapshot.
 *
 * **Resuming.** Every frame carries a monotonic `id:` (the panel-wide sequence, so one counter serves
 * every stream and every reconnect). A client that reconnects sends `Last-Event-ID` (an `EventSource`
 * does it by itself) or `?since=<seq>` (a `fetch` reader), and the stream answers with **one current
 * snapshot first, then the replay** of the buffered `log` frames published after that sequence.
 *
 * That order is the contract, and the ids say so: `hello` carries the sequence it *describes*, and the
 * replayed frames keep their original (older) ids. So a resumed client sees the newest state, then log
 * lines that predate it — it must apply the replay to its log buffer only, never as fresher state.
 * `hello`/`state`/`server` frames are snapshots and are never replayed: a replay of an older snapshot
 * would regress what the client was just handed.
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
        description: 'Every frame carries an `id:` sequence. Reconnect with `Last-Event-ID` (or `?since=<seq>`) to replay the buffered `log` frames after one current snapshot.',
        parameters: [{
          name: 'since',
          in: 'query',
          required: false,
          description: 'Resume after this sequence (the last `id:` the client saw).',
          schema: { type: 'integer' },
        }],
        responses: { 200: sseResponse('one frame per event: `hello`, `state`, `server`, `log`, `ping`'), 404: ERROR_RESPONSES[404] },
      }),
      validate('query', eventsQuery),
      (c) => {
        const query = c.req.valid('query')
        const serverId = query.serverId ?? null
        const includeLogs = query.logs !== false
        const since = resumePoint(c, query.since)

        // A server id is unique only inside its workspace, so naming one without a workspace means
        // the default workspace — the rule every other workspace-scoped route follows — never "any".
        // The lookup runs whenever either is named, so both a bad workspace and a bad server 404.
        const runtime = serverId === null && query.workspace === undefined
          ? null
          : requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), query.workspace)
        const workspaceId = runtime?.id ?? null
        if (serverId !== null && runtime !== null && !runtime.store.getServer(serverId))
          throw unknownServerError(serverId)

        return serveEventStream(c, deps.auth, (send, resumeFrom) => {
          const subscription = workspaceId !== null && serverId !== null ? serverKey(workspaceId, serverId) : null
          const accepts = (message: SseMessage): boolean => {
            if (!includeLogs && message.type === 'log')
              return false
            // `?workspace=` alone narrows server and log frames; state frames are panel-wide.
            if (subscription === null && workspaceId !== null && 'workspaceId' in message && message.workspaceId !== workspaceId)
              return false
            return true
          }
          const hello: SseMessage = { type: 'hello', ts: Date.now(), state: deps.panel.getState() }

          // Both branches are synchronous from the first send to the subscription, so no frame can
          // slip in between and a client always reads `hello` before anything else. A fresh stream
          // subscribes first so a frame published as it opens is queued, not dropped.
          if (resumeFrom === null) {
            const unsubscribe = deps.hub.subscribe(subscription, (message, seq) => {
              if (accepts(message))
                send(message, seq)
            })
            send(hello)
            return unsubscribe
          }

          // Resuming: the snapshot goes first (it is current), then the replay of older log frames.
          send(hello)
          return deps.hub.subscribeFrom(subscription, resumeFrom, (message, seq) => {
            if (accepts(message))
              send(message, seq)
          })
        }, { since, currentSeq: () => deps.hub.lastSeq })
      },
    )
}
