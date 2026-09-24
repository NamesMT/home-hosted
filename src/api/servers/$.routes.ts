import type { AppDeps } from '#src/app'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { streamSSE } from 'hono/streaming'
import { ConfigError } from '#src/config/store'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { freePortResultSchema, logQuerySchema, serverCreateSchema, serverPatchSchema, serverViewSchema } from '#src/shared/contracts'

const idParam = type({ id: 'string >= 1' })
const serverResponse = type({ server: serverViewSchema })
const serversResponse = type({ servers: serverViewSchema.array() })
const okResponse = type({ ok: 'boolean' })

/** Unknown ids are 404; a server that exists but cannot start is a 409. */
function statusFor(result: { ok: boolean, error?: string }): 200 | 404 | 409 {
  if (result.ok)
    return 200
  return result.error?.startsWith('unknown server') ? 404 : 409
}

function unknownServer(id: string): DetailedError {
  return new DetailedError(`unknown server "${id}"`, { statusCode: 404, code: 'UNKNOWN_SERVER' })
}

export function createServersRoute(deps: AppDeps) {
  return appFactory.createApp()
    .get(
      '/',
      describeRoute({
        tags: ['servers'],
        summary: 'Every supervised server, with its live state',
        responses: { 200: { description: 'The servers', content: jsonBody(serversResponse) } },
      }),
      c => c.json({ servers: deps.supervisor.views() }),
    )

    .post(
      '/',
      describeRoute({
        tags: ['servers'],
        summary: 'Add a server',
        responses: {
          201: { description: 'Created', content: jsonBody(serverResponse) },
          400: ERROR_RESPONSES[400],
        },
      }),
      validate('json', serverCreateSchema),
      (c) => {
        const body = c.req.valid('json')
        try {
          return c.json({ server: deps.store.addServer(body) }, 201)
        }
        catch (error) {
          if (error instanceof ConfigError)
            throw new DetailedError(error.message, { statusCode: 400, code: 'INVALID_SERVER' })
          throw error
        }
      },
    )

    // Registered before `/:id` so the literal segments always win.
    .post(
      '/start-all',
      describeRoute({ tags: ['servers'], summary: 'Start every enabled server', responses: { 200: { description: 'The servers', content: jsonBody(serversResponse) } } }),
      async (c) => {
        await deps.supervisor.startAll()
        return c.json({ servers: deps.supervisor.views() })
      },
    )

    .post(
      '/stop-all',
      describeRoute({ tags: ['servers'], summary: 'Stop every server', responses: { 200: { description: 'The servers', content: jsonBody(serversResponse) } } }),
      async (c) => {
        await deps.supervisor.stopAll()
        return c.json({ servers: deps.supervisor.views() })
      },
    )

    .get(
      '/:id',
      describeRoute({ tags: ['servers'], summary: 'One server', responses: { 200: { description: 'The server', content: jsonBody(serverResponse) }, 404: ERROR_RESPONSES[404] } }),
      validate('param', idParam),
      (c) => {
        const { id } = c.req.valid('param')
        const server = deps.supervisor.views().find(entry => entry.id === id)
        if (!server)
          throw unknownServer(id)
        return c.json({ server })
      },
    )

    .get(
      '/:id/logs',
      describeRoute({ tags: ['servers'], summary: 'Buffered log lines from memory', responses: { 200: { description: 'Lines' }, 404: ERROR_RESPONSES[404] } }),
      validate('param', idParam),
      validate('query', logQuerySchema),
      (c) => {
        const { id } = c.req.valid('param')
        if (!deps.store.getServer(id))
          throw unknownServer(id)

        const { limit } = c.req.valid('query')
        const parsed = limit === undefined ? Number.NaN : Number.parseInt(limit, 10)
        // Clamped: a negative or huge value must not slice from the wrong end.
        const bounded = Number.isNaN(parsed) ? undefined : Math.min(Math.max(parsed, 1), 100_000)
        return c.json({ lines: deps.supervisor.logLines(id, bounded) })
      },
    )

    .get(
      '/:id/stream',
      describeRoute({ tags: ['servers'], summary: 'Server state and logs as server-sent events', responses: { 200: { description: 'text/event-stream' }, 404: ERROR_RESPONSES[404] } }),
      validate('param', idParam),
      (c) => {
        const { id } = c.req.valid('param')
        if (!deps.store.getServer(id))
          throw unknownServer(id)

        return streamSSE(c, async (stream) => {
          let closed = false
          let queue: Promise<void> = Promise.resolve()
          const send = (data: string, event: string): void => {
            if (closed)
              return
            queue = queue.then(() => stream.writeSSE({ event, data })).catch(() => {
              closed = true
            })
          }

          const unsubscribe = deps.hub.subscribe(id, (message) => {
            send(JSON.stringify(message), message.type)
          })
          stream.onAbort(() => {
            closed = true
            unsubscribe()
          })

          const server = deps.supervisor.views().find(entry => entry.id === id)
          send(JSON.stringify({ type: 'server', ts: Date.now(), serverId: id, server }), 'server')
          send(JSON.stringify({
            type: 'log',
            ts: Date.now(),
            serverId: id,
            lines: deps.supervisor.logLines(id, 200),
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
      describeRoute({ tags: ['servers'], summary: 'Start a server', responses: { 200: { description: 'Result' }, 404: ERROR_RESPONSES[404] } }),
      validate('param', idParam),
      async (c) => {
        const result = await deps.supervisor.start(c.req.valid('param').id)
        return c.json(result, statusFor(result))
      },
    )

    .post(
      '/:id/stop',
      describeRoute({ tags: ['servers'], summary: 'Stop a server', responses: { 200: { description: 'Result' }, 404: ERROR_RESPONSES[404] } }),
      validate('param', idParam),
      async (c) => {
        const result = await deps.supervisor.stop(c.req.valid('param').id)
        return c.json(result, result.ok ? 200 : 404)
      },
    )

    .post(
      '/:id/restart',
      describeRoute({ tags: ['servers'], summary: 'Restart a server', responses: { 200: { description: 'Result' }, 404: ERROR_RESPONSES[404] } }),
      validate('param', idParam),
      async (c) => {
        const result = await deps.supervisor.restart(c.req.valid('param').id)
        return c.json(result, statusFor(result))
      },
    )

    .post(
      '/:id/clear-logs',
      describeRoute({ tags: ['servers'], summary: 'Forget the buffered log lines', responses: { 200: { description: 'Cleared', content: jsonBody(okResponse) } } }),
      validate('param', idParam),
      (c) => {
        deps.supervisor.clearLogs(c.req.valid('param').id)
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
      validate('param', idParam),
      async (c) => {
        const { id } = c.req.valid('param')
        const result = await deps.supervisor.freePort(id)
        if (!result.ok)
          throw new DetailedError(result.error ?? `could not free the port for "${id}"`, { statusCode: statusFor(result), code: 'FREE_PORT_FAILED' })
        return c.json(result)
      },
    )

    .patch(
      '/:id',
      describeRoute({ tags: ['servers'], summary: 'Edit a server', responses: { 200: { description: 'The server', content: jsonBody(serverResponse) }, 400: ERROR_RESPONSES[400], 404: ERROR_RESPONSES[404] } }),
      validate('param', idParam),
      validate('json', serverPatchSchema),
      (c) => {
        try {
          return c.json({ server: deps.store.updateServer(c.req.valid('param').id, c.req.valid('json')) })
        }
        catch (error) {
          if (error instanceof ConfigError) {
            const status = error.message.startsWith('unknown server') ? 404 : 400
            throw new DetailedError(error.message, { statusCode: status, code: status === 404 ? 'UNKNOWN_SERVER' : 'INVALID_SERVER' })
          }
          throw error
        }
      },
    )

    .delete(
      '/:id',
      describeRoute({ tags: ['servers'], summary: 'Stop and remove a server', responses: { 200: { description: 'Removed', content: jsonBody(okResponse) }, 404: ERROR_RESPONSES[404] } }),
      validate('param', idParam),
      async (c) => {
        const { id } = c.req.valid('param')
        try {
          await deps.supervisor.stop(id)
          deps.store.removeServer(id)
          return c.json({ ok: true })
        }
        catch (error) {
          if (error instanceof ConfigError)
            throw unknownServer(id)
          throw error
        }
      },
    )
}
