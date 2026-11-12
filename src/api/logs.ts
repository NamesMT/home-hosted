import type { AppDeps } from '#src/app'
import fs, { createReadStream } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { unknownServerError } from '#src/helpers/action-result'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { requireWorkspace, workspaceQuerySchema } from '#src/helpers/workspace'
import { logHistoryQuerySchema, logLinesResponseSchema, logServersViewSchema, okResponseSchema } from '#src/shared/contracts'
import { lazy } from '#src/shared/lazy'

/**
 * The tail window's top, and what a request that names no `tail` gets.
 *
 * The floor lives in `logHistoryQuerySchema` with the top, because a query schema is where a query
 * value is decided: `?tail=3` is a `400` naming the parameter, never a silent clamp to 50.
 */
const MAX_TAIL = 5000
const DEFAULT_TAIL = 500

const idParam = lazy(() => type({ id: 'string >= 1' }))
// The workspace schema is the **argument** in both, and that is what keeps these strict: `merge`
// takes the argument's `onUndeclaredKey`, so `extra.merge(workspaceQuerySchema)` refuses a
// misspelt key while `workspaceQuerySchema.merge(extra)` would have lost the rejection and run the
// request against the default workspace.
const downloadQuery = lazy(() => type({ 'file?': 'string' }).merge(workspaceQuerySchema))
const historyQuery = lazy(() => logHistoryQuerySchema.merge(workspaceQuerySchema))

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
        responses: { 200: { description: 'Lines', content: jsonBody(logLinesResponseSchema) }, 404: ERROR_RESPONSES[404] },
      }),
      validate('query', historyQuery),
      validate('param', idParam),
      async (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        if (!runtime.store.getServer(id))
          throw unknownServerError(id)

        const query = c.req.valid('query')
        // Parsed and bounded by `logHistoryQuerySchema`, so it is already the number asked for: a
        // value outside `MIN_TAIL`–`MAX_TAIL` was refused at the boundary rather than clamped here.
        const tail = query.tail ?? DEFAULT_TAIL

        const info = runtime.logFiles.info(id)
        const search = query.search?.trim() ?? ''
        const stream = query.stream ?? ''

        /**
         * `since`/`before` are cursors, not counts: they select *which* lines to answer with, and the
         * window they can select is bounded like `tail` is. A cursor with no reachable line inside the
         * readable window is refused rather than answered with a silently short list — "here are 0 of
         * the 5000 you asked for" reads as "nothing was logged", which is the one answer a log route
         * must never give when it simply did not look far enough.
         */
        const since = query.since
        const before = query.before
        if (since !== undefined && before !== undefined && since >= before) {
          throw new DetailedError('`since` must be an earlier cursor than `before` — they select opposite halves of one window', {
            statusCode: 400,
            code: 'INVALID_INPUT',
          })
        }

        /**
         * A filter that keeps only *some* of the lines has to read a wider window than the
         * display tail, or "the last 500 stderr lines" silently means "the stderr lines among
         * the last 500 overall" — 50 of them, in a log where every tenth line is stderr, and
         * 500 exist. `search` already widened for exactly this reason; `stream` is the same
         * shape of filter and did not, so it was short whenever the two streams interleave.
         */
        const filterWindow = search.length > 0 || stream.length > 0 ? Math.max(tail, MAX_TAIL) : tail
        // A cursor may name a line anywhere in the readable history, so it reads the widest window
        // this route offers: sizing by `tail` would answer "nothing after that cursor" for a cursor
        // older than `tail`, which reads as "nothing was logged".
        const window = since !== undefined || before !== undefined ? MAX_TAIL : filterWindow

        let lines = await runtime.logFiles.readTail(id, window)
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

        /**
         * A cursor older than everything this route reads is **refused**, not answered with a short
         * list: the window is capped at `MAX_TAIL` lines, so a cursor below the oldest line here means
         * lines are on disk that were not read. Answering `[]` (or just the visible remainder) would
         * say "nothing was logged in between" — the one thing a log route must never claim when it did
         * not look far enough. The refusal names the way to look properly.
         */
        const windowFull = windowLines >= window
        const oldest = lines[0]?.ts
        if (windowFull && (since !== undefined || before !== undefined)) {
          const belowWindow = since !== undefined
            ? since < (oldest ?? Infinity)
            : before !== undefined && before <= (oldest ?? Infinity)
          if (belowWindow) {
            throw new DetailedError(`the cursor is older than the ${window} lines this route reads — read further back with \`GET /api/logs/${id}/download\`, or read the log file on disk`, {
              statusCode: 400,
              code: 'CURSOR_OUT_OF_RANGE',
            })
          }
        }

        /**
         * The cursors are exclusive on both ends — "after this line" / "before this line" — so a client
         * polling in both directions never sees a line twice. Each keeps at most `tail` lines **in the
         * direction it is paging** (`since` hands back the oldest first, so a client can continue from
         * the last id it received; `before` hands back the newest), and a page that comes back exactly
         * `tail` long means "ask again from the new cursor".
         */
        if (since !== undefined) {
          lines = lines.filter(line => line.ts > since)
          return c.json({
            serverId: id,
            enabled: info.enabled,
            sizeBytes: info.sizeBytes,
            files: info.files.map(file => file.name),
            searched: search.length > 0 ? windowLines : null,
            lines: lines.slice(0, tail),
          })
        }
        if (before !== undefined) {
          lines = lines.filter(line => line.ts < before)
          return c.json({
            serverId: id,
            enabled: info.enabled,
            sizeBytes: info.sizeBytes,
            files: info.files.map(file => file.name),
            searched: search.length > 0 ? windowLines : null,
            lines: lines.slice(-tail),
          })
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
        responses: { 200: { description: 'the log file, one JSON line per entry', content: { 'application/x-ndjson': {} } }, 404: ERROR_RESPONSES[404] },
      }),
      validate('query', downloadQuery),
      validate('param', idParam),
      async (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        if (!runtime.store.getServer(id))
          throw unknownServerError(id)

        const requested = c.req.valid('query').file ?? `${id}.log`
        const known = runtime.logFiles.info(id).files.map(file => file.name)
        if (!known.includes(requested))
          throw new DetailedError('unknown log file', { statusCode: 404, code: 'UNKNOWN_LOG_FILE' })

        const file = path.join(runtime.logFiles.directory, requested)
        /**
         * Streamed, not read into memory. This is the same class the archive download answers, and the
         * logs are the *bigger* case in practice: `logs.maxBytes` bounds one rotation at up to 100 MB and
         * `keep` keeps 10 of them, and a person downloads exactly when a log is large.
         *
         * Measured on the built panel with a real 100 MB rotation: `readFileSync` cost **+199 MB RSS**
         * for one download and **+402 MB** for four arriving together, `/healthz` went from 4 ms to
         * p95 859 ms / max 898 ms, and the headers only arrived after the whole read (TTFB 272 ms). The
         * archive route with the same four downloads grew **+2 MB** and answered `/healthz` in p50 17 ms.
         * `stat` gives the same `Content-Length` a client needs for a progress bar without the buffer.
         */
        const stats = await fs.promises.stat(file)
        return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream, 200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Length': String(stats.size),
          'Content-Disposition': `attachment; filename="${requested}"`,
        })
      },
    )

    .delete(
      '/logs/:id',
      describeRoute({
        tags: ['logs'],
        summary: 'Delete the persisted logs of one server',
        responses: { 200: { description: 'Cleared', content: jsonBody(okResponseSchema) }, 404: ERROR_RESPONSES[404] },
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
