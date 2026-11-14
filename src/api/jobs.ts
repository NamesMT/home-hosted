import type { AppDeps } from '#src/app'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { ConfigError } from '#src/config/settings'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { requireWorkspace, workspaceQuerySchema } from '#src/helpers/workspace'
import { jobCreateSchema, jobEntryViewSchema, jobPatchSchema, jobsListSchema, okResponseSchema } from '#src/shared/contracts'
import { lazy } from '#src/shared/lazy'
import { booleanParam } from '#src/shared/query-params'

/**
 * `/api/jobs` — a workspace's short-lived commands on cron schedules.
 *
 * Its own route file because a job is its own domain: it has no port, no health check and no restart
 * policy, and nothing here shares a lifecycle with `/api/servers`. The two used to be one entry kind
 * in one file, which is what forced `kind` onto every server and half the Servers page to explain it.
 */

const idParam = lazy(() => type({ id: 'string >= 1' }))
const jobResponse = lazy(() => type({ job: jobEntryViewSchema }))
const jobsQuery = lazy(() => type({ 'wait?': booleanParam }).merge(workspaceQuerySchema))

/**
 * A jobs-file failure as the answer it deserves.
 *
 * `INVALID_CONFIG`/`INVALID_JOB` are the file being wrong (400, and the message names the line the
 * person has to fix); `JOB_EXISTS` is a duplicate id (409). Nothing here is a 500: a broken hand-edit
 * is the owner's to act on, and the message says which entry and why.
 */
function jobFailure(error: ConfigError): DetailedError {
  // A duplicate is a conflict; a file or entry that cannot be used is a bad request — the message
  // names what to fix. 404 is only for an id that does not exist, which is a different error path.
  const status = error.code === 'JOB_EXISTS' ? 409 : 400
  return new DetailedError(error.message, { statusCode: status, code: error.code ?? 'INVALID_JOB' })
}

export function createJobsRoute(deps: AppDeps) {
  return appFactory.createApp()
    .get(
      '/jobs',
      describeRoute({
        tags: ['jobs'],
        summary: 'Every job in a workspace, with what each is doing',
        responses: { 200: { description: 'The jobs', content: jsonBody(jobsListSchema) }, 404: ERROR_RESPONSES[404] },
      }),
      validate('query', workspaceQuerySchema),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        try {
          return c.json({ jobs: runtime.jobs.list() })
        }
        catch (error) {
          if (error instanceof ConfigError)
            throw jobFailure(error)
          throw error
        }
      },
    )

    .post(
      '/jobs',
      describeRoute({
        tags: ['jobs'],
        summary: 'Declare a job',
        responses: { 201: { description: 'The job', content: jsonBody(jobResponse) }, 400: ERROR_RESPONSES[400], 409: ERROR_RESPONSES[409] },
      }),
      validate('query', workspaceQuerySchema),
      validate('json', jobCreateSchema),
      async (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        try {
          // The schema's defaults fill what the caller omitted, so the stored entry is complete —
          // `jobSchema` is the store's own shape, and `jobCreateSchema` is the request's.
          const body = c.req.valid('json')
          const { jobSchema } = await import('#src/shared/contracts')
          const entry = jobSchema(body)
          if (entry instanceof type.errors)
            throw new DetailedError(entry.summary, { statusCode: 400, code: 'INVALID_INPUT' })
          runtime.jobs.jobs.add(entry)
          return c.json({ job: runtime.jobs.list().find(candidate => candidate.id === entry.id)! }, 201)
        }
        catch (error) {
          if (error instanceof ConfigError)
            throw jobFailure(error)
          throw error
        }
      },
    )

    .patch(
      '/jobs/:id',
      describeRoute({
        tags: ['jobs'],
        summary: 'Edit a job',
        responses: { 200: { description: 'The job', content: jsonBody(jobResponse) }, 400: ERROR_RESPONSES[400], 404: ERROR_RESPONSES[404] },
      }),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      validate('json', jobPatchSchema),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        try {
          if (runtime.jobs.jobs.update(id, c.req.valid('json')) === null)
            throw new DetailedError(`no job with the id "${id}"`, { statusCode: 404, code: 'UNKNOWN_JOB' })
          return c.json({ job: runtime.jobs.list().find(entry => entry.id === id)! })
        }
        catch (error) {
          if (error instanceof ConfigError)
            throw jobFailure(error)
          throw error
        }
      },
    )

    .delete(
      '/jobs/:id',
      describeRoute({
        tags: ['jobs'],
        summary: 'Remove a job',
        responses: { 200: { description: 'Removed', content: jsonBody(okResponseSchema) }, 404: ERROR_RESPONSES[404] },
      }),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        // A removed job must not keep running: its log and history would outlive the entry.
        void runtime.jobs.stop(id)
        if (!runtime.jobs.jobs.remove(id))
          throw new DetailedError(`no job with the id "${id}"`, { statusCode: 404, code: 'UNKNOWN_JOB' })
        return c.json({ ok: true })
      },
    )

    /**
     * Stop a run in flight.
     *
     * A separate act from removing the job: a person watching a backup go wrong wants to end *this
     * run*, and a job that is mid-write is not one to delete out from under its process.
     */
    .post(
      '/jobs/:id/stop',
      describeRoute({
        tags: ['jobs'],
        summary: 'Stop a run in flight',
        responses: { 200: { description: 'Stopped, or nothing was running', content: jsonBody(okResponseSchema) }, 404: ERROR_RESPONSES[404] },
      }),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      async (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        if (runtime.jobs.get(id) === null)
          throw new DetailedError(`no job with the id "${id}"`, { statusCode: 404, code: 'UNKNOWN_JOB' })
        // `false` means nothing was running, which is an answered question rather than an error.
        await runtime.jobs.stop(id)
        return c.json({ ok: true })
      },
    )

    /**
     * Run one **now**, and wait for the exit code.
     *
     * The whole point of a job is its outcome, so this waits by default; `?wait=false` answers `202`
     * for a caller that will watch the log instead. A run already in flight is `409 JOB_RUNNING`,
     * never queued behind itself.
     */
    .post(
      '/jobs/:id/run',
      describeRoute({
        tags: ['jobs'],
        summary: 'Run a job now and wait for its exit code',
        responses: {
          200: { description: 'Ran', content: jsonBody(type({ 'ok': 'boolean', 'exitCode?': 'number | null', 'durationMs?': 'number', 'cancelled?': 'boolean', 'error?': 'string' })) },
          202: { description: 'Started, with `?wait=false`', content: jsonBody(okResponseSchema) },
          404: ERROR_RESPONSES[404],
          409: ERROR_RESPONSES[409],
        },
      }),
      validate('query', jobsQuery),
      validate('param', idParam),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        if (runtime.jobs.get(id) === null)
          throw new DetailedError(`no job with the id "${id}"`, { statusCode: 404, code: 'UNKNOWN_JOB' })

        if (c.req.valid('query').wait === false) {
          void runtime.jobs.run(id)
          return c.json({ ok: true }, 202)
        }

        return (async () => {
          const record = await runtime.jobs.run(id)
          if (record === null)
            throw new DetailedError(`job "${id}" is already running`, { statusCode: 409, code: 'JOB_RUNNING' })
          const durationMs = record.endedAt === null ? 0 : record.endedAt - record.startedAt
          return c.json({
            ok: record.exitCode === 0 && !record.cancelled,
            exitCode: record.exitCode,
            durationMs,
            cancelled: record.cancelled,
          })
        })()
      },
    )
}
