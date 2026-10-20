import type { AppDeps } from '#src/app'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { streamSSE } from 'hono/streaming'
import { ConfigError } from '#src/config/store'
import { actionAnswer, actionCode, statusForAction, unknownServerError } from '#src/helpers/action-result'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { requireWorkspace, workspaceQuerySchema } from '#src/helpers/workspace'
import { requestActor } from '#src/middleware/auth'
import { serverKey } from '#src/services/events'
import { actionResultSchema, freePortResultSchema, logLinesResponseSchema, logQuerySchema, okResponseSchema, serverCreateSchema, serverPatchSchema, serverSchema, serverViewSchema } from '#src/shared/contracts'

const idParam = type({ id: 'string >= 1' })
/** Pending SSE writes per connection; log frames are dropped past it, state is not. */
const MAX_PENDING_WRITES = 200
const serverResponse = type({ server: serverViewSchema })
const serversResponse = type({ servers: serverViewSchema.array() })
/**
 * A write answers the *stored* entry, not a view: `addServer`/`updateServer` return the
 * `ServerConfig` they committed, which is flat and carries no live status. Declaring the
 * view here was wrong and quietly misled clients — a consumer reading `server.config`
 * off a create got `undefined` with no error anywhere.
 */
const storedServerResponse = type({ server: serverSchema })
const bufferedLogsQuery = logQuerySchema.merge(workspaceQuerySchema)

export function createServersRoute(deps: AppDeps) {
  return appFactory.createApp()
    .get(
      '/',
      describeRoute({
        tags: ['servers'],
        summary: 'Every supervised server in one workspace, with its live state',
        responses: { 200: { description: 'The servers', content: jsonBody(serversResponse) } },
      }),
      validate('query', workspaceQuerySchema),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        return c.json({ servers: runtime.supervisor.views() })
      },
    )

    .post(
      '/',
      describeRoute({
        tags: ['servers'],
        summary: 'Add a server to a workspace',
        responses: {
          201: { description: 'Created', content: jsonBody(storedServerResponse) },
          400: ERROR_RESPONSES[400],
        },
      }),
      validate('query', workspaceQuerySchema),
      validate('json', serverCreateSchema),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        try {
          return c.json({ server: runtime.store.addServer(c.req.valid('json')) }, 201)
        }
        catch (error) {
          if (error instanceof ConfigError)
            throw new DetailedError(error.message, { statusCode: 400, code: 'INVALID_SERVER' })
          throw error
        }
      },
    )

    /**
     * Declare an entry whether or not it exists — "make it so", for config management.
     *
     * `POST` refuses a duplicate and `PATCH` only merges, so a deploy script had to GET, diff and
     * then pick one; a re-run of an unchanged declaration answered `400 INVALID_SERVER` for its
     * trouble. The body is the whole entry (the create schema), never a patch, so a re-run
     * converges: 201 when it created, 200 when it replaced.
     */
    .put(
      '/:id',
      describeRoute({
        tags: ['servers'],
        summary: 'Create or replace one entry (idempotent)',
        responses: {
          200: { description: 'Replaced', content: jsonBody(storedServerResponse) },
          201: { description: 'Created', content: jsonBody(storedServerResponse) },
          400: ERROR_RESPONSES[400],
        },
      }),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      validate('json', serverCreateSchema),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        const body = c.req.valid('json')
        // The path names the entry; a body naming a different one is a mistake, not a rename.
        if (body.id !== id)
          throw new DetailedError(`the body's id "${body.id}" does not match the path id "${id}"`, { statusCode: 400, code: 'ID_MISMATCH' })

        try {
          const result = runtime.store.putServer(body)
          return c.json({ server: result.server }, result.created ? 201 : 200)
        }
        catch (error) {
          if (error instanceof ConfigError)
            throw new DetailedError(error.message, { statusCode: 400, code: 'INVALID_SERVER' })
          throw error
        }
      },
    )

    /**
     * Stop a process the panel started that no entry claims any more.
     *
     * The orphan list is on the workspace view; this is the action that makes it recoverable from
     * the panel instead of from `ps` and `kill` in a shell.
     */
    .post(
      '/orphans/:id/stop',
      describeRoute({
        tags: ['servers'],
        summary: 'Stop an orphaned process this panel started',
        responses: { 200: { description: 'Stopped', content: jsonBody(okResponseSchema) }, 404: ERROR_RESPONSES[404], 409: { description: 'The process survived the stop' } },
      }),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      async (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const id = c.req.valid('param').id
        const result = await runtime.supervisor.stopOrphan(id)
        if (!result.ok) {
          // 404 when nothing is running under that id; 409 when a process is there and refused to
          // die — two different fixes, and the declared 409 had no path to it.
          const survived = result.error?.includes('survived the stop') === true
          throw new DetailedError(result.error ?? `could not stop the orphaned process "${id}"`, {
            statusCode: survived ? 409 : 404,
            code: survived ? 'ORPHAN_SURVIVED' : 'UNKNOWN_ORPHAN',
          })
        }
        return c.json({ ok: true })
      },
    )

    // Registered before `/:id` so the literal segments always win.
    .post(
      '/start-all',
      describeRoute({ tags: ['servers'], summary: 'Start every enabled server in a workspace', responses: { 200: { description: 'The servers', content: jsonBody(serversResponse) } } }),
      validate('query', workspaceQuerySchema),
      async (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        await runtime.supervisor.startAll()
        return c.json({ servers: runtime.supervisor.views() })
      },
    )

    .post(
      '/stop-all',
      describeRoute({ tags: ['servers'], summary: 'Stop every server in a workspace', responses: { 200: { description: 'The servers', content: jsonBody(serversResponse) } } }),
      validate('query', workspaceQuerySchema),
      async (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        await runtime.supervisor.stopAll()
        return c.json({ servers: runtime.supervisor.views() })
      },
    )

    .get(
      '/:id',
      describeRoute({ tags: ['servers'], summary: 'One server', responses: { 200: { description: 'The server', content: jsonBody(serverResponse) }, 404: ERROR_RESPONSES[404] } }),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        const server = runtime.supervisor.views().find(entry => entry.id === id)
        if (!server)
          throw unknownServerError(id)
        return c.json({ server })
      },
    )

    .get(
      '/:id/logs',
      describeRoute({ tags: ['servers'], summary: 'Buffered log lines from memory', responses: { 200: { description: 'Lines', content: jsonBody(logLinesResponseSchema) }, 404: ERROR_RESPONSES[404] } }),
      validate('query', bufferedLogsQuery),
      validate('param', idParam),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        if (!runtime.store.getServer(id))
          throw unknownServerError(id)

        const { limit } = c.req.valid('query')
        const parsed = limit === undefined ? Number.NaN : Number.parseInt(limit, 10)
        // Clamped: a negative or huge value must not slice from the wrong end.
        const bounded = Number.isNaN(parsed) ? undefined : Math.min(Math.max(parsed, 1), 100_000)
        return c.json({ lines: runtime.supervisor.logLines(id, bounded) })
      },
    )

    .get(
      '/:id/stream',
      describeRoute({ tags: ['servers'], summary: 'Server state and logs as server-sent events', responses: { 200: { description: 'text/event-stream' }, 404: ERROR_RESPONSES[404] } }),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        if (!runtime.store.getServer(id))
          throw unknownServerError(id)

        return streamSSE(c, async (stream) => {
          let closed = false
          let pending = 0
          let queue: Promise<void> = Promise.resolve()
          const send = (data: string, event: string): void => {
            if (closed)
              return
            // Same rule as the panel-wide stream: a slow client loses the chatty
            // server's log frames before it grows an unbounded write queue.
            if (event === 'log' && pending > MAX_PENDING_WRITES)
              return
            pending += 1
            queue = queue.then(() => stream.writeSSE({ event, data })).catch(() => {
              closed = true
            }).finally(() => {
              pending -= 1
            })
          }

          const unsubscribe = deps.hub.subscribe(serverKey(runtime.id, id), (message) => {
            send(JSON.stringify(message), message.type)
          })
          stream.onAbort(() => {
            closed = true
            unsubscribe()
          })

          const server = runtime.supervisor.views().find(entry => entry.id === id)
          send(JSON.stringify({ type: 'server', ts: Date.now(), workspaceId: runtime.id, serverId: id, server }), 'server')
          send(JSON.stringify({
            type: 'log',
            ts: Date.now(),
            workspaceId: runtime.id,
            serverId: id,
            lines: runtime.supervisor.logLines(id, 200),
          }), 'log')

          while (true) {
            await stream.sleep(15000)
            if (closed)
              break
            await stream.writeSSE({ event: 'ping', data: String(Date.now()) })
          }
        })
      },
    )

    .post(
      '/:id/start',
      describeRoute({ tags: ['servers'], summary: 'Start a server', responses: { 200: { description: 'Result', content: jsonBody(actionResultSchema) }, 404: ERROR_RESPONSES[404], 409: { description: 'The entry cannot act right now' } } }),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      async (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const result = await runtime.supervisor.start(c.req.valid('param').id, { actor: requestActor(c, deps.auth) })
        return c.json(actionAnswer(result), statusForAction(result))
      },
    )

    .post(
      '/:id/stop',
      describeRoute({ tags: ['servers'], summary: 'Stop a server', responses: { 200: { description: 'Result', content: jsonBody(actionResultSchema) }, 404: ERROR_RESPONSES[404], 409: { description: 'The entry cannot act right now' } } }),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      async (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const result = await runtime.supervisor.stop(c.req.valid('param').id)
        return c.json(actionAnswer(result), statusForAction(result))
      },
    )

    .post(
      '/:id/restart',
      describeRoute({ tags: ['servers'], summary: 'Restart a server', responses: { 200: { description: 'Result', content: jsonBody(actionResultSchema) }, 404: ERROR_RESPONSES[404], 409: { description: 'The entry cannot act right now' } } }),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      async (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const result = await runtime.supervisor.restart(c.req.valid('param').id, { actor: requestActor(c, deps.auth) })
        return c.json(actionAnswer(result), statusForAction(result))
      },
    )

    .post(
      '/:id/clear-logs',
      describeRoute({ tags: ['servers'], summary: 'Forget the buffered log lines', responses: { 200: { description: 'Cleared', content: jsonBody(okResponseSchema) } } }),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        // `200 {"ok":true}` for an id that never existed is a lie a script believes: it cannot
        // tell "cleared" from "I typo'd the id".
        if (!runtime.store.getServer(id))
          throw unknownServerError(id)
        runtime.supervisor.clearLogs(id)
        return c.json({ ok: true })
      },
    )

    /**
     * The escape hatch for `port x is already in use (pid x)`: it re-lists the
     * listeners itself, so what is killed is the process holding the port now —
     * never a pid quoted in an old message, and never one this panel supervises.
     */
    .post(
      '/:id/free-port',
      describeRoute({
        tags: ['servers'],
        summary: 'Ask whatever holds this server\'s port to stop',
        responses: {
          200: { description: 'What was signalled', content: jsonBody(freePortResultSchema) },
          404: ERROR_RESPONSES[404],
          409: { description: 'Nothing to free, or the holder is supervised by this panel' },
        },
      }),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      async (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        const result = await runtime.supervisor.freePort(id)
        if (!result.ok) {
          // `UNKNOWN_SERVER` for a missing id, because that is the fix the caller needs; every
          // other refusal here is genuinely about the port.
          throw new DetailedError(result.error ?? `could not free the port for "${id}"`, {
            statusCode: statusForAction(result),
            code: actionCode(result) === 'UNKNOWN_SERVER' ? 'UNKNOWN_SERVER' : 'FREE_PORT_FAILED',
          })
        }
        return c.json(result)
      },
    )

    .patch(
      '/:id',
      describeRoute({ tags: ['servers'], summary: 'Edit a server', responses: { 200: { description: 'The server', content: jsonBody(storedServerResponse) }, 400: ERROR_RESPONSES[400], 404: ERROR_RESPONSES[404] } }),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      validate('json', serverPatchSchema),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        try {
          return c.json({ server: runtime.store.updateServer(c.req.valid('param').id, c.req.valid('json')) })
        }
        catch (error) {
          if (error instanceof ConfigError) {
            // Branch on the exception's *code*, not its message: `startsWith('unknown server')` read
            // any future message with that prefix — "unknown serverless runtime" — as a missing id.
            const status = error.code === 'UNKNOWN_SERVER' ? 404 : 400
            throw new DetailedError(error.message, { statusCode: status, code: status === 404 ? 'UNKNOWN_SERVER' : 'INVALID_SERVER' })
          }
          throw error
        }
      },
    )

    .delete(
      '/:id',
      describeRoute({ tags: ['servers'], summary: 'Stop and remove a server', responses: { 200: { description: 'Removed', content: jsonBody(okResponseSchema) }, 404: ERROR_RESPONSES[404] } }),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      async (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        try {
          await runtime.supervisor.stop(id)
          runtime.store.removeServer(id)
          return c.json({ ok: true })
        }
        catch (error) {
          if (error instanceof ConfigError)
            throw unknownServerError(id)
          throw error
        }
      },
    )
}
