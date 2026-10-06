import type { AppDeps } from '#src/app'
import fs from 'node:fs'
import path from 'node:path'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { unknownServerError } from '#src/helpers/action-result'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { requireWorkspace, workspaceQuerySchema } from '#src/helpers/workspace'
import { logHistoryQuerySchema, logServersViewSchema } from '#src/shared/contracts'

/** Bounds for the tail query, so a bad client cannot ask for the whole file. */
const MIN_TAIL = 50
const MAX_TAIL = 5000
const DEFAULT_TAIL = 500

const idParam = type({ id: 'string >= 1' })
const downloadQuery = type({ 'file?': 'string' }).merge(workspaceQuerySchema)
const historyQuery = logHistoryQuerySchema.merge(workspaceQuerySchema)

export function createLogsRoute(deps: AppDeps) {
  return appFactory.createApp()
    .get(
      '/logs',
      describeRoute({
        tags: ['logs'],
        summary: 'Every server in one workspace with its on-disk log files',
        responses: { 200: { description: 'Log sources', content: jsonBody(logServersViewSchema) } },
      }),
      validate('query', workspaceQuerySchema),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        return c.json({
          servers: runtime.supervisor.views().map(server => ({
            serverId: server.id,
            label: server.config.label ?? server.id,
            status: server.status,
            ...runtime.logFiles.info(server.id),
          })),
        })
      },
    )

    .get(
      '/logs/:id',
      describeRoute({
        tags: ['logs'],
        summary: 'Persisted log lines, with search and a stream filter',
        responses: { 200: { description: 'Lines' }, 404: ERROR_RESPONSES[404] },
      }),
      validate('query', historyQuery),
      validate('param', idParam),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        if (!runtime.store.getServer(id))
          throw unknownServerError(id)

        const query = c.req.valid('query')
        const requested = query.tail === undefined ? DEFAULT_TAIL : Number.parseInt(query.tail, 10)
        const tail = Number.isNaN(requested) ? DEFAULT_TAIL : Math.min(Math.max(requested, MIN_TAIL), MAX_TAIL)

        const info = runtime.logFiles.info(id)
        const search = query.search?.trim() ?? ''
        const stream = query.stream ?? ''

        /**
         * A filter that keeps only *some* of the lines has to read a wider window than the
         * display tail, or "the last 500 stderr lines" silently means "the stderr lines among
         * the last 500 overall" — 50 of them, in a log where every tenth line is stderr, and
         * 500 exist. `search` already widened for exactly this reason; `stream` is the same
         * shape of filter and did not, so it was short whenever the two streams interleave.
         */
        const window = search.length > 0 || stream.length > 0 ? Math.max(tail, MAX_TAIL) : tail

        let lines = runtime.logFiles.readTail(id, window)
        if (stream.length > 0)
          lines = lines.filter(line => line.stream === stream)

        // What the search actually looked at, which is not always what it asked for: a log
        // shorter than the window yields fewer lines, and the UI prints this number verbatim
        // ("searched 5000 lines"). Reporting the *requested* window told a person reading a
        // 100-line log that 5000 lines had been searched.
        const windowLines = lines.length

        if (search.length > 0) {
          const needle = search.toLowerCase()
          lines = lines.filter(line => line.text.toLowerCase().includes(needle))
        }

        return c.json({
          serverId: id,
          enabled: info.enabled,
          sizeBytes: info.sizeBytes,
          files: info.files.map(file => file.name),
          searched: search.length > 0 ? windowLines : null,
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
      validate('query', downloadQuery),
      validate('param', idParam),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        if (!runtime.store.getServer(id))
          throw unknownServerError(id)

        const requested = c.req.valid('query').file ?? `${id}.log`
        const known = runtime.logFiles.info(id).files.map(file => file.name)
        if (!known.includes(requested))
          throw new DetailedError('unknown log file', { statusCode: 404, code: 'UNKNOWN_LOG_FILE' })

        const file = path.join(runtime.logFiles.directory, requested)
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
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        if (!runtime.store.getServer(id))
          throw unknownServerError(id)
        runtime.logFiles.clear(id)
        return c.json({ ok: true })
      },
    )
}
