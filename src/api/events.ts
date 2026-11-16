import type { AppDeps } from '#src/app'
import type { SseMessage } from '#src/shared/contracts'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { unknownServerError } from '#src/helpers/action-result'
import { resumePoint, serveEventStream } from '#src/helpers/event-stream'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, sseResponse } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { requireWorkspace, workspaceLimit } from '#src/helpers/workspace'
import { serverKey } from '#src/services/events'
import { narrowStateFor } from '#src/services/state'
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

        /**
         * The workspaces a credential may see frames from, or `null` for "no narrowing".
         *
         * The live feed is the one `/api` read that is **not** narrowed by `?workspace=` alone: it
         * also carries a `log` frame for every workspace, and the state frame names every workspace.
         * Declared panel-wide, it handed an account limited to `staging` the default workspace's
         * output — measured, a `staging`-limited `read` account subscribed with no query at all and
         * received `DEFAULT-LEAK` from `default`'s `web`. Its sibling `GET /api/logs?workspace=default`
         * refuses that account, so a limit that held on the polling route and not on the streaming one
         * was no limit: the stream is the cheaper way to watch a workspace you may not read.
         *
         * A session, this machine, and an unlimited credential get `null` — scopes are about
         * credentials, and the UIs open the panel-wide stream with no query so their selector still
         * works.
         */
        // The auth guard already resolved this request's credential and stored it, so the limit is
        // read from there rather than resolved a second time — a second `requestIdentity` would slide
        // the session, and this is a long-lived connection (the same reason `serveEventStream`
        // re-checks with `{ slide: false }`). One definition, in `src/helpers/workspace.ts`, so the
        // guard, this feed, the scrape and the snapshots cannot disagree about who may see what.
        const limit = workspaceLimit(c)

        // A server id is unique only inside its workspace, so naming one without a workspace means
        // the default workspace — the rule every other workspace-scoped route follows — never "any".
        // The lookup runs whenever either is named, so both a bad workspace and a bad server 404.
        const runtime = serverId === null && query.workspace === undefined
          ? null
          : requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), query.workspace)
        const workspaceId = runtime?.id ?? null
        if (serverId !== null && runtime !== null && !runtime.store.getServer(serverId))
          throw unknownServerError(serverId)

        // Naming a workspace the credential may not read is the same refusal the polling route gives,
        // rather than an empty stream: silence reads as "nothing is happening", which is the one thing
        // a live feed must never say about a workspace it was asked for and declined.
        if (limit !== null && workspaceId !== null && !limit.includes(workspaceId)) {
          throw new DetailedError(
            `this account is limited to ${limit.join(', ')} — it cannot watch "${workspaceId}"`,
            { statusCode: 403, code: 'TOKEN_SCOPE', detail: { workspaces: limit } },
          )
        }

        return serveEventStream(c, deps.auth, (send, resumeFrom) => {
          const subscription = workspaceId !== null && serverId !== null ? serverKey(workspaceId, serverId) : null
          /**
           * The frame to deliver, or `null` to drop it.
           *
           * A **snapshot** frame is narrowed rather than dropped: `hello`/`state` are the panel in one
           * payload, so a limited credential's copy is cut down to its own workspaces (the same
           * `narrowStateFor` `GET /api/state` uses). Filtering on `workspaceId` alone left them whole,
           * which handed a `staging`-limited account `default`'s every server — id, command, pid and
           * status — over the stream whose polling sibling refuses that same account.
           */
          const shape = (message: SseMessage): SseMessage | null => {
            if (!includeLogs && message.type === 'log')
              return null
            if (message.type === 'hello' || message.type === 'state')
              return { ...message, state: narrowStateFor(message.state, limit) }
            // A limited credential sees server and log frames only for the workspaces it names.
            if (limit !== null && 'workspaceId' in message && message.workspaceId !== undefined && !limit.includes(message.workspaceId))
              return null
            // `?workspace=` alone narrows server and log frames; snapshots are panel-wide.
            if (subscription === null && workspaceId !== null && 'workspaceId' in message && message.workspaceId !== workspaceId)
              return null
            return message
          }
          const hello: SseMessage = { type: 'hello', ts: Date.now(), state: narrowStateFor(deps.panel.getState(), limit) }

          // Both branches are synchronous from the first send to the subscription, so no frame can
          // slip in between and a client always reads `hello` before anything else. A fresh stream
          // subscribes first so a frame published as it opens is queued, not dropped.
          if (resumeFrom === null) {
            const unsubscribe = deps.hub.subscribe(subscription, (message, seq) => {
              const shaped = shape(message)
              if (shaped !== null)
                send(shaped, seq)
            })
            send(hello)
            return unsubscribe
          }

          // Resuming: the snapshot goes first (it is current), then the replay of older log frames.
          send(hello)
          return deps.hub.subscribeFrom(subscription, resumeFrom, (message, seq) => {
            const shaped = shape(message)
            if (shaped !== null)
              send(shaped, seq)
          })
        }, { since, currentSeq: () => deps.hub.lastSeq })
      },
    )
}
