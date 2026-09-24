import type { AppDeps } from '#src/app'
import fs from 'node:fs'
import path from 'node:path'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { logHistoryQuerySchema, logServersViewSchema } from '#src/shared/contracts'

/** Bounds for the tail query, so a bad client cannot ask for the whole file. */
const MIN_TAIL = 50
const MAX_TAIL = 5000
const DEFAULT_TAIL = 500

const idParam = type({ id: 'string >= 1' })
const downloadQuery = type({ 'file?': 'string' })

function unknownServer(id: string): DetailedError {
  return new DetailedError(`unknown server "${id}"`, { statusCode: 404, code: 'UNKNOWN_SERVER' })
}

export function createLogsRoute(deps: AppDeps) {
  return appFactory.createApp()
    .get(
      '/logs',
      describeRoute({
        tags: ['logs'],
        summary: 'Every server with its on-disk log files',
        responses: { 200: { description: 'Log sources', content: jsonBody(logServersViewSchema) } },
      }),
      c => c.json({
        servers: deps.supervisor.views().map(server => ({
          serverId: server.id,
          label: server.config.label ?? server.id,
          status: server.status,
          ...deps.logFiles.info(server.id),
        })),
      }),
    )

    .get(
      '/logs/:id',
      describeRoute({
        tags: ['logs'],
        summary: 'Persisted log lines, with search and a stream filter',
        responses: { 200: { description: 'Lines' }, 404: ERROR_RESPONSES[404] },
      }),
      validate('param', idParam),
      validate('query', logHistoryQuerySchema),
      (c) => {
        const { id } = c.req.valid('param')
        if (!deps.store.getServer(id))
          throw unknownServer(id)

        const query = c.req.valid('query')
        const requested = query.tail === undefined ? DEFAULT_TAIL : Number.parseInt(query.tail, 10)
        const tail = Number.isNaN(requested) ? DEFAULT_TAIL : Math.min(Math.max(requested, MIN_TAIL), MAX_TAIL)

        const info = deps.logFiles.info(id)
        // Search reads a wider window than the display tail, otherwise a match older
        // than the last N lines would look like "no results".
        const search = query.search?.trim() ?? ''
        const window = search.length > 0 ? Math.max(tail, MAX_TAIL) : tail

        let lines = deps.logFiles.readTail(id, window)
        if (query.stream !== undefined && query.stream.length > 0)
          lines = lines.filter(line => line.stream === query.stream)
        if (search.length > 0) {
          const needle = search.toLowerCase()
          lines = lines.filter(line => line.text.toLowerCase().includes(needle))
        }

        return c.json({
          serverId: id,
          enabled: info.enabled,
          sizeBytes: info.sizeBytes,
          files: info.files.map(file => file.name),
          searched: search.length > 0 ? window : null,
          lines: lines.slice(-tail),
        })
      },
    )

    /** Raw file download; the name is checked against the rotation allowlist. */
    .get(
      '/logs/:id/download',
      describeRoute({
        tags: ['logs'],
        summary: 'Download one rotated log file',
        responses: { 200: { description: 'application/x-ndjson' }, 404: ERROR_RESPONSES[404] },
      }),
      validate('param', idParam),
      validate('query', downloadQuery),
      (c) => {
        const { id } = c.req.valid('param')
        if (!deps.store.getServer(id))
          throw unknownServer(id)

        const requested = c.req.valid('query').file ?? `${id}.log`
        const known = deps.logFiles.info(id).files.map(file => file.name)
        if (!known.includes(requested))
          throw new DetailedError('unknown log file', { statusCode: 404, code: 'UNKNOWN_LOG_FILE' })

        const file = path.join(deps.logFiles.directory, requested)
        const body = fs.readFileSync(file)
        return c.body(body, 200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Length': String(body.byteLength),
          'Content-Disposition': `attachment; filename="${requested}"`,
        })
      },
    )

    .delete(
      '/logs/:id',
      describeRoute({
        tags: ['logs'],
        summary: 'Delete the persisted logs of one server',
        responses: { 200: { description: 'Cleared' }, 404: ERROR_RESPONSES[404] },
      }),
      validate('param', idParam),
      (c) => {
        const { id } = c.req.valid('param')
        if (!deps.store.getServer(id))
          throw unknownServer(id)
        deps.logFiles.clear(id)
        return c.json({ ok: true })
      },
    )
}
