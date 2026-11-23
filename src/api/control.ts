import type { Context } from 'hono'
import type { AppDeps } from '#src/app'
import type { BackupPlanResponse } from '#src/shared/contracts'
import path from 'node:path'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { actionAnswer, statusForAction } from '#src/helpers/action-result'
import { afterResponse } from '#src/helpers/deferred'
import { appFactory } from '#src/helpers/factory'
import { logger } from '#src/helpers/logger'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { secretEqual } from '#src/helpers/secret-compare'
import { addServerEntry } from '#src/helpers/server-create'
import { validate } from '#src/helpers/validator'
import { requireWorkspace, workspaceQuerySchema } from '#src/helpers/workspace'
import { isLoopbackRequest } from '#src/middleware/loopback'

import { selectionOf } from '#src/shared/backup-scope'
import { actionResultSchema, backupLocalResponseSchema, backupSelectionSchema, freePortResultSchema, jobLogViewSchema, jobRunResultSchema, okResponseSchema, restorePlanSchema, serverCreateSchema, serverSchema, serverSecretsSchema, serverViewSchema, usageViewSchema } from '#src/shared/contracts'
import { lazy } from '#src/shared/lazy'
import { booleanParam } from '#src/shared/query-params'

/**
 * The local control channel used by `home-hosted down` and `home-hosted start|stop`.
 *
 * It is deliberately outside `/api` (so no session is needed) and guarded by a
 * token that only the owner of `run.json` can read, plus a loopback check: a
 * different local user, or anyone on the network, gets nothing.
 */
/** The local channel's query keys, declared so a typo is refused and the spec names them. */
const shutdownQuery = lazy(() => type({ 'withPersistent?': booleanParam }).onUndeclaredKey('reject'))
const backupQuery = lazy(() => type({ 'password?': 'string', 'include?': 'string', 'exclude?': 'string', 'confirm?': booleanParam }).onUndeclaredKey('reject'))
const serversListResponse = lazy(() => type({ servers: serverViewSchema.array() }))
// A stored entry, as `POST /api/servers` answers it; an answer never rejects a newer field.
const storedServerResponse = lazy(() => type({ server: serverSchema }).onDeepUndeclaredKey('ignore'))
const controlSecretsSchema = lazy(() => serverSecretsSchema)
const idParam = lazy(() => type({ id: 'string >= 1' }))
const restoreQuery = lazy(() => type({ 'password?': 'string', 'include?': 'string', 'exclude?': 'string', 'confirm?': booleanParam, 'name?': 'string', 'from?': 'string' }).onUndeclaredKey('reject'))

export function createControlRoute(deps: AppDeps) {
  /** The one place the local channel's credentials are read. */
  function assertLocalCall(c: Context, action: string): void {
    const token = c.req.header('x-home-hosted-token')
    // Constant-time: this channel is outside `/api`, so the token is the only thing guarding it, and a
    // byte-by-byte timing recovery by another local user is exactly what it exists to stop.
    if (token === undefined || !secretEqual(token, deps.runtimeToken))
      throw new DetailedError('invalid token', { statusCode: 403, code: 'INVALID_TOKEN' })
    if (!isLoopbackRequest(c))
      throw new DetailedError(`only this machine may ${action}`, { statusCode: 403, code: 'NOT_LOOPBACK' })
  }

  /**
   * The credential check, as **middleware**, so it runs before anything reads the body.
   *
   * `assertLocalCall` was called from inside each handler, which put it *after*
   * `validate('json', …)`: the body is parsed to validate it, so an unauthenticated caller could make
   * the panel buffer and schema-walk a payload of its choosing before being refused. Measured on the
   * local channel with a 2 MB body and no token, the answer was `400 INVALID_INPUT` naming a field
   * rather than `403`, with ~3 MB of heap used to say it — pre-auth work proportional to the request,
   * on a channel whose whole design is "the token is the only guard". It also leaked the expected
   * body shape of a privileged route to a caller that had not proved anything.
   *
   * Only the routes that read a body need this (`POST /_hh/servers` and
   * `POST /_hh/servers/secrets/:id`); the rest answer from the query string, where validation is a
   * few bytes of URL and the handler's own check is already the first thing that looks at anything.
   */
  function requireLocalCall(action: string) {
    return async (c: Context, next: () => Promise<void>): Promise<void> => {
      assertLocalCall(c, action)
      await next()
    }
  }

  return appFactory.createApp()
    .post(
      '/shutdown',
      describeRoute({
        tags: ['panel'],
        summary: 'Stop the panel and everything it supervises (local token required)',
        responses: { 200: { description: 'Stopping', content: jsonBody(okResponseSchema) }, 403: { description: 'Bad token, or not a local caller' } },
      }),
      validate('query', shutdownQuery),
      (c) => {
        assertLocalCall(c, 'stop the control panel')

        // `?withPersistent=true` is `down --with-persistent`: a persistent entry survives this
        // shutdown by design, so only an explicit ask ends it — and doing it here, while the
        // panel is still alive, is what records the stop.
        const withPersistent = c.req.valid('query').withPersistent ?? false
        // Deferred: the answer has to reach `down` before the process goes away.
        afterResponse(() => deps.onShutdown({ withPersistent }), error => logger.error('shutdown failed', error))

        return c.json({ ok: true })
      },
    )

    .post(
      '/servers/:id/start',
      describeRoute({
        tags: ['panel'],
        summary: 'Start one server, without a session (local token required)',
        responses: { 200: { description: 'Started', content: jsonBody(actionResultSchema) }, 403: { description: 'Bad token, or not a local caller' }, 404: { description: 'No such server' }, 409: { description: 'The entry cannot act right now; `code` names why (`SERVER_DISABLED`, `SERVER_BUSY`, `PORT_IN_USE`, `DEPENDENCY_FAILED`, else `ACTION_FAILED`)' } },
      }),
      validate('query', workspaceQuerySchema),
      async (c) => {
        assertLocalCall(c, 'start or stop a server')
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const result = await runtime.supervisor.start(c.req.param('id'), { actor: 'user' })
        return c.json(actionAnswer(result), statusForAction(result))
      },
    )

    /**
     * Every server in one workspace, over the local channel — `home-hosted ls`. The same views
     * `GET /api/servers` answers, so the CLI and the panel cannot disagree about what is declared.
     */
    .get(
      '/servers',
      describeRoute({
        tags: ['panel'],
        summary: 'Every server in one workspace with its live state (local token required)',
        responses: { 200: { description: 'The servers', content: jsonBody(serversListResponse) }, 403: { description: 'Bad token, or not a local caller' }, 404: ERROR_RESPONSES[404] },
      }),
      validate('query', workspaceQuerySchema),
      (c) => {
        assertLocalCall(c, 'list servers')
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        return c.json({ servers: runtime.supervisor.views() })
      },
    )

    /**
     * A workspace's jobs, over the local channel — `home-hosted job ls` while the panel runs.
     *
     * Jobs had a CLI (`job ls`, `job run`) whose only path was the **browser** client: `listJobs`
     * built a relative `/api/jobs`, which a terminal cannot resolve, and `job run` posted to
     * `/_hh/jobs/:id/run`, a route nobody had written. `job ls` died on the URL and `job run` on the
     * 404, so the command's own doc comment described a working pair that did not exist. These two
     * routes are the missing halves, on the channel the CLI already uses.
     */
    .get(
      '/jobs',
      describeRoute({
        tags: ['panel'],
        summary: 'Every job in one workspace, with what each is doing (local token required)',
        responses: { 200: { description: 'The jobs', content: jsonBody(type({ jobs: 'unknown[]' })) }, 403: { description: 'Bad token, or not a local caller' }, 404: ERROR_RESPONSES[404] },
      }),
      validate('query', workspaceQuerySchema),
      (c) => {
        assertLocalCall(c, 'list jobs')
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        return c.json({ jobs: runtime.jobs.list() })
      },
    )

    /**
     * A job's own log, over the local channel — `home-hosted job log <id>` while the panel runs.
     *
     * The same lines `GET /api/jobs/:id/log` serves, and the same reader behind both. The CLI needs
     * this because a run's output is **no longer** in the panel log: it goes to the job's own file, so
     * a command that told a person to read the panel log was pointing at the wrong place.
     */
    .get(
      '/jobs/:id/log',
      describeRoute({
        tags: ['panel'],
        summary: 'A job\'s own log lines (local token required)',
        responses: { 200: { description: 'Lines', content: jsonBody(jobLogViewSchema) }, 403: { description: 'Bad token, or not a local caller' }, 404: ERROR_RESPONSES[404] },
      }),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      async (c) => {
        assertLocalCall(c, 'read a job log')
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        if (runtime.jobs.get(id) === null)
          throw new DetailedError(`no job with the id "${id}"`, { statusCode: 404, code: 'UNKNOWN_JOB' })
        const info = runtime.jobs.logInfo(id)
        return c.json({
          jobId: id,
          enabled: info.enabled,
          sizeBytes: info.sizeBytes,
          files: info.files.map(file => file.name),
          lines: await runtime.jobs.readLog(id, 500),
        })
      },
    )

    /**
     * Run one job now and wait for its exit code, over the local channel.
     *
     * `POST`, and it **waits**: a job's exit code is its outcome, and `job run` exits 1 on failure, so
     * an "accepted" answer would leave a script believing a backup ran that it did not. The same
     * service the `/api` route calls, so the history event and the notification cannot drift.
     */
    .post(
      '/jobs/:id/run',
      describeRoute({
        tags: ['panel'],
        summary: 'Run a job now and wait for its exit code (local token required)',
        responses: { 200: { description: 'Ran', content: jsonBody(jobRunResultSchema) }, 403: { description: 'Bad token, or not a local caller' }, 404: ERROR_RESPONSES[404], 409: ERROR_RESPONSES[409] },
      }),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      async (c) => {
        assertLocalCall(c, 'run a job')
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        if (runtime.jobs.get(id) === null)
          throw new DetailedError(`no job with the id "${id}"`, { statusCode: 404, code: 'UNKNOWN_JOB' })
        const record = await runtime.jobs.run(id)
        if (record === null)
          throw new DetailedError(`job "${id}" is already running`, { statusCode: 409, code: 'JOB_RUNNING' })
        const durationMs = record.endedAt === null ? 0 : record.endedAt - record.startedAt
        return c.json({
          ok: record.exitCode === 0 && !record.cancelled,
          exitCode: record.exitCode,
          signal: record.signal,
          durationMs,
          cancelled: record.cancelled,
        })
      },
    )

    /**
     * Run one entry's deploy steps, over the local channel — `home-hosted deploy` while the panel
     * runs.
     *
     * `POST` like every other `/_hh` write, and it **waits** for the outcome: the CLI prints what
     * happened, and a "started" answer would leave the caller believing a deploy succeeded that may
     * still be on its first step.
     */
    .post(
      '/servers/:id/deploy',
      describeRoute({
        tags: ['panel'],
        summary: 'Run a server\'s deploy steps and wait for the outcome (local token required)',
        responses: { 200: { description: 'Deployed', content: jsonBody(okResponseSchema) }, 400: ERROR_RESPONSES[400], 403: { description: 'Bad token, or not a local caller' }, 404: ERROR_RESPONSES[404], 409: ERROR_RESPONSES[409] },
      }),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      async (c) => {
        assertLocalCall(c, 'deploy a server')
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const result = await runtime.supervisor.deploy(c.req.valid('param').id)
        if (result.ok)
          return c.json({ ok: true })
        const status = result.code === 'UNKNOWN_SERVER' ? 404 : result.code === 'NO_DEPLOY' ? 400 : 409
        throw new DetailedError(result.error ?? 'the deploy failed', { statusCode: status, code: result.code ?? 'DEPLOY_FAILED' })
      },
    )

    /**
     * A server's secret environment, over the local channel — `home-hosted secret` while the panel
     * runs.
     *
     * `POST`, because the local channel has no `PUT`: `requestControl` speaks GET and POST and every
     * `/_hh` write already uses POST. The body is the same shape `PUT /api/servers/:id/secrets`
     * takes, and nothing is echoed back.
     */
    .post(
      '/servers/secrets/:id',
      describeRoute({
        tags: ['panel'],
        summary: 'Set or clear a server\'s secret environment values (local token required)',
        responses: { 200: { description: 'Written', content: jsonBody(okResponseSchema) }, 400: ERROR_RESPONSES[400], 403: { description: 'Bad token, or not a local caller' }, 404: ERROR_RESPONSES[404] },
      }),
      requireLocalCall('read or write a server\'s secrets'),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      validate('json', controlSecretsSchema),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        const entry = runtime.store.getServer(id)
        if (!entry)
          throw new DetailedError(`unknown server "${id}"`, { statusCode: 404, code: 'UNKNOWN_SERVER' })

        const body = c.req.valid('json')
        const declared = new Set(entry.secretEnv)
        const writing = Object.keys(body.set ?? {})
        const undeclared = writing.filter(name => !declared.has(name))
        if (undeclared.length > 0)
          throw new DetailedError(`${undeclared.map(name => `"${name}"`).join(', ')} ${undeclared.length === 1 ? 'is' : 'are'} not declared in this server's secretEnv`, { statusCode: 400, code: 'INVALID_INPUT' })

        if ((body.unset ?? []).length > 0)
          runtime.secrets.unsetServerEnv(id, body.unset ?? [])
        if (writing.length > 0) {
          const next = { ...runtime.secrets.serverEnv(id) }
          for (const [name, value] of Object.entries(body.set ?? {}))
            next[name] = value
          runtime.secrets.setServerEnv(id, next)
        }
        return c.json({ ok: true })
      },
    )

    /**
     * A **job's** secret environment, over the local channel — the job half of the server route above.
     *
     * `docs/JOBS.md` documents `home-hosted secret set <job> BACKUP_TOKEN` and `secret ls <job>`, and
     * both were broken: `src/cli/secret.ts` resolves its id against `servers.config.json` only, so a
     * job id answered `unknown server "nightly-backup"` — telling a person to declare a server that
     * must not exist, for a command the docs say works. The panel's own `PUT /api/jobs/:id/secrets`
     * has existed since a job's `secretEnv` first reached a process; this is the local channel's copy
     * of it, so the CLI has something to call when the panel runs.
     *
     * The two maps are separate by design (`jobEnv` beside `serverEnv`), so an id that is both a job
     * and a server never has one overwrite the other.
     */
    .post(
      '/jobs/secrets/:id',
      describeRoute({
        tags: ['panel'],
        summary: 'Set or clear a job\'s secret environment values (local token required)',
        responses: { 200: { description: 'Written', content: jsonBody(okResponseSchema) }, 400: ERROR_RESPONSES[400], 403: { description: 'Bad token, or not a local caller' }, 404: ERROR_RESPONSES[404] },
      }),
      requireLocalCall('read or write a job\'s secrets'),
      validate('query', workspaceQuerySchema),
      validate('param', idParam),
      validate('json', controlSecretsSchema),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const { id } = c.req.valid('param')
        const job = runtime.jobs.get(id)
        if (job === null)
          throw new DetailedError(`unknown job "${id}"`, { statusCode: 404, code: 'UNKNOWN_JOB' })

        const body = c.req.valid('json')
        const declared = new Set(job.secretEnv)
        const writing = Object.keys(body.set ?? {})
        const undeclared = writing.filter(name => !declared.has(name))
        if (undeclared.length > 0) {
          throw new DetailedError(
            `${undeclared.map(name => `"${name}"`).join(', ')} ${undeclared.length === 1 ? 'is' : 'are'} not declared in this job's secretEnv — add ${undeclared.length === 1 ? 'the name' : 'the names'} to the job first`,
            { statusCode: 400, code: 'INVALID_INPUT', detail: [{ path: 'set', message: `declare ${undeclared.join(', ')} in secretEnv` }] },
          )
        }

        if ((body.unset ?? []).length > 0)
          runtime.secrets.unsetJobEnv(id, body.unset ?? [])
        if (writing.length > 0) {
          // The **job** map, never `serverEnv`: an id is unique only within its own domain.
          const next = { ...runtime.secrets.jobEnv(id) }
          for (const [name, value] of Object.entries(body.set ?? {}))
            next[name] = value
          runtime.secrets.setJobEnv(id, next)
        }
        return c.json({ ok: true })
      },
    )

    /**
     * Add one entry, over the local channel — `home-hosted add` while the panel is up. The same body,
     * validation and refusals as `POST /api/servers` (`addServerEntry`); like it, the entry is not
     * started, `autostart` or not.
     */
    .post(
      '/servers',
      describeRoute({
        tags: ['panel'],
        summary: 'Add a server to a workspace (local token required)',
        responses: {
          201: { description: 'Created; not started', content: jsonBody(storedServerResponse) },
          400: ERROR_RESPONSES[400],
          403: { description: 'Bad token, or not a local caller' },
          409: { description: 'An entry with this id already exists (`SERVER_EXISTS`), or the config changed on disk (`CONFIG_CHANGED_ON_DISK`)', content: ERROR_RESPONSES[409].content },
        },
      }),
      requireLocalCall('add a server'),
      validate('query', workspaceQuerySchema),
      validate('json', serverCreateSchema),
      (c) => {
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        return c.json({ server: addServerEntry(runtime.store, c.req.valid('json')) }, 201)
      },
    )

    /**
     * One server's live view, over the local channel.
     *
     * A read, like `GET /_hh/usage`: `start` returns the moment the process is spawned, which is
     * right for the panel but wrong for a script — `start x && curl x` raced every boot, and an
     * entry whose command exits immediately still reported "started". The CLI asks this a moment
     * later and tells the truth, rather than re-deriving the state from a second source.
     */
    .get(
      '/servers/:id',
      describeRoute({
        tags: ['panel'],
        summary: 'One server\'s live state, without a session (local token required)',
        responses: { 200: { description: 'The view', content: jsonBody(serverViewSchema) }, 403: { description: 'Bad token, or not a local caller' }, 404: { description: 'No such server' } },
      }),
      validate('query', workspaceQuerySchema),
      (c) => {
        assertLocalCall(c, 'read one server')
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const id = c.req.param('id')
        const view = runtime.supervisor.views().find(entry => entry.id === id)
        if (view === undefined)
          throw new DetailedError(`unknown server "${id}"`, { statusCode: 404, code: 'UNKNOWN_SERVER' })
        return c.json(view)
      },
    )

    .post(
      '/servers/:id/stop',
      describeRoute({
        tags: ['panel'],
        summary: 'Stop one server, without a session (local token required)',
        responses: { 200: { description: 'Stopped', content: jsonBody(actionResultSchema) }, 403: { description: 'Bad token, or not a local caller' }, 404: { description: 'No such server' }, 409: { description: 'The entry cannot act right now; `code` names why (`SERVER_DISABLED`, `SERVER_BUSY`, `PORT_IN_USE`, `DEPENDENCY_FAILED`, else `ACTION_FAILED`)' } },
      }),
      validate('query', workspaceQuerySchema),
      async (c) => {
        assertLocalCall(c, 'start or stop a server')
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const result = await runtime.supervisor.stop(c.req.param('id'))
        return c.json(actionAnswer(result), statusForAction(result))
      },
    )

    // The panel's own `restart` is the daemon; this is one entry. The UI has had a Restart
    // button on every server card, and the supervisor has always had `restart()`, so the
    // shell was the only client that could not do it.
    .post(
      '/servers/:id/restart',
      describeRoute({
        tags: ['panel'],
        summary: 'Restart one server, without a session (local token required)',
        responses: { 200: { description: 'Restarted', content: jsonBody(actionResultSchema) }, 403: { description: 'Bad token, or not a local caller' }, 404: { description: 'No such server' }, 409: { description: 'The entry cannot act right now; `code` names why (`SERVER_DISABLED`, `SERVER_BUSY`, `PORT_IN_USE`, `DEPENDENCY_FAILED`, else `ACTION_FAILED`)' } },
      }),
      validate('query', workspaceQuerySchema),
      async (c) => {
        assertLocalCall(c, 'restart a server')
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const result = await runtime.supervisor.restart(c.req.param('id'), { actor: 'user' })
        return c.json(actionAnswer(result), statusForAction(result))
      },
    )

    // The UI has had a **Free port** button; the shell could not reach it. It is a destructive
    // action (it signals processes the panel does not own), so it is a command of its own with the
    // same refusals rather than a flag on `start` — `start --free-port` is the convenient spelling
    // and adds nothing to the rules.
    .post(
      '/servers/:id/free-port',
      describeRoute({
        tags: ['panel'],
        summary: 'Free one server\'s port, without a session (local token required)',
        responses: {
          200: { description: 'What was signalled', content: jsonBody(freePortResultSchema) },
          403: { description: 'Bad token, or not a local caller' },
          404: { description: 'No such server' },
          409: { description: 'Nothing to free, or the holder is supervised by this panel' },
        },
      }),
      validate('query', workspaceQuerySchema),
      async (c) => {
        assertLocalCall(c, 'free a server\'s port')
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const result = await runtime.supervisor.freePort(c.req.param('id'))
        // `ok: false` carries the sentence a person acts on, and the status says which kind of
        // failure it was — the same pair the `/api` route answers, so the two cannot disagree.
        return c.json(actionAnswer(result), statusForAction(result))
      },
    )

    /**
     * Backups over the local channel, so an operator (or a cron job) can take and restore one
     * without a browser session. The panel stays the only writer: these call the same service the
     * `/api/backups` routes do, so the archive shape and the allowlist cannot drift.
     */
    .get(
      '/backups',
      describeRoute({
        tags: ['panel'],
        summary: 'List the stored backup archives (local token required)',
        responses: { 200: { description: 'The archives', content: jsonBody(backupSelectionSchema) }, 403: { description: 'Bad token, or not a local caller' } },
      }),
      (c) => {
        assertLocalCall(c, 'list backups')
        return c.json(deps.backups.selection())
      },
    )

    /**
     * Every server's live resource reading, over the local channel.
     *
     * A read, like `GET /_hh/backups`: `home-hosted usage` is the operator's "which of my twelve
     * services is eating memory" question, and the answer already exists on every view. Putting it
     * on `/_hh` keeps the CLI on its own token-plus-loopback channel instead of opening an `/api`
     * route or inventing a browser session.
     *
     * Absent readings stay absent — a stopped entry sends no `cpuPercent`/`rssBytes` rather than a
     * zero, which is the same rule the metrics scrape follows.
     */
    .get(
      '/usage',
      describeRoute({
        tags: ['panel'],
        summary: 'Every server\'s live CPU and memory (local token required)',
        responses: { 200: { description: 'The readings', content: jsonBody(usageViewSchema) }, 403: { description: 'Bad token, or not a local caller' } },
      }),
      (c) => {
        assertLocalCall(c, 'read resource usage')
        return c.json(buildUsage(deps))
      },
    )

    .post(
      '/backups',
      describeRoute({
        tags: ['panel'],
        summary: 'Plan a backup, or create it with `confirm=true` (local token required)',
        responses: { 200: { description: 'Without `confirm=true`, the plan (`apply: false`) and nothing written; with it, the archive created', content: jsonBody(backupLocalResponseSchema) }, 400: ERROR_RESPONSES[400], 403: { description: 'Bad token, or not a local caller' } },
      }),
      validate('query', backupQuery),
      async (c) => {
        assertLocalCall(c, 'create a backup')
        // Query, not body: the local channel's request helper sends no payload, and `workspace`
        // already travels this way. The password is in the URL on loopback only, which is the same
        // trust boundary as the token in the header.
        const password = c.req.valid('query').password
        const include = c.req.valid('query').include?.split(',').filter(part => part.length > 0)
        const exclude = c.req.valid('query').exclude?.split(',').filter(part => part.length > 0)
        // Without `confirm` this answers the plan and writes nothing, so a script can read what a
        // backup would capture before taking one.
        if (c.req.valid('query').confirm !== true) {
          // `selection()` for the entries, `view()` for `includePaths`: the model is off the state
          // frame now, and a plan still needs both halves.
          const view = deps.backups.selection()
          const includePaths = deps.backups.view().includePaths
          // The service's own selection rule, so the plan cannot disagree with what an apply writes —
          // that divergence is exactly how `--exclude` would work on backup and do nothing in a plan.
          const selects = selectionOf({ include, exclude })
          // Leaves are filtered as well as entries: a plan naming a leaf the apply will leave out is
          // a plan for a different backup.
          // A leaf selection keeps its parent entry in the plan: `--include workspace:default:servers`
          // captures that one file, and a plan showing nothing for it describes no backup at all.
          const namesLeafOf = (id: string): boolean =>
            include !== undefined && include.some(entry => entry.startsWith(`${id}:`))
          const entries = view.entries
            .filter(entry => selects(entry.id) || namesLeafOf(entry.id))
            .map(entry => ({ ...entry, items: entry.items.filter(item => selects(item.id)) }))
          return c.json({ apply: false, entries, includePaths } satisfies BackupPlanResponse)
        }
        const result = await deps.backups.create({ password, include, exclude })
        if (!result.ok)
          throw new DetailedError(result.error ?? 'the backup failed', { statusCode: 400, code: 'BACKUP_FAILED' })
        return c.json({ file: result.file, files: deps.backups.list(), ...(result.warnings === undefined ? {} : { warnings: result.warnings }) })
      },
    )

    .post(
      '/backups/restore',
      describeRoute({
        tags: ['panel'],
        summary: 'Plan or apply a restore from a stored archive or a file on this machine (local token required)',
        responses: { 200: { description: 'The plan', content: jsonBody(restorePlanSchema) }, 400: ERROR_RESPONSES[400], 403: { description: 'Bad token, or not a local caller' }, 404: ERROR_RESPONSES[404] },
      }),
      validate('query', restoreQuery),
      async (c) => {
        assertLocalCall(c, 'restore a backup')
        const confirm = c.req.valid('query').confirm === true
        const name = c.req.valid('query').name
        const from = c.req.valid('query').from
        // `name` (an allowlist entry in the backups directory) or `from` (a file anywhere) — exactly
        // one. Both name the same thing, so taking one silently would be a guess on the destructive
        // path, and `--from` is additive: a caller still passing `name` keeps the behaviour it had.
        //
        // `from` is a new input class, so the question "can it escape the restore allowlist" is
        // answered here: it changes only where the bytes are *read* from. A restore writes to a
        // staging directory it creates, then only to the paths the live config declares, and every
        // entry is checked by `admitArchive` — so an arbitrary path cannot reach a write target that
        // a name-in-the-directory could not. Nor does it widen who may call: the local channel needs
        // run.json's token and a loopback peer, which is the same user who could read that file
        // without the panel at all.
        if (from !== undefined && from.length > 0 && name !== undefined && name.length > 0)
          throw new DetailedError('pass name or from, not both', { statusCode: 400, code: 'NAME_AND_FROM' })
        if (from === undefined || from.length === 0) {
          if (name === undefined || name.length === 0)
            throw new DetailedError('name is required', { statusCode: 400, code: 'MISSING_NAME' })
          // `resolve` is the allowlist: it refuses anything that is not a plain archive name.
          const archive = deps.backups.resolve(name)
          if (archive === null)
            throw new DetailedError(`no backup named "${name}"`, { statusCode: 404, code: 'BACKUP_NOT_FOUND' })
          const include = c.req.valid('query').include?.split(',').filter(part => part.length > 0)
          const exclude = c.req.valid('query').exclude?.split(',').filter(part => part.length > 0)
          return c.json(await deps.backups.restore(archive, { confirm, password: c.req.valid('query').password, include, exclude }))
        }

        // Absolute only: this process's working directory is not the caller's, so a relative path
        // would silently read a different file than the one the person typed.
        if (!path.isAbsolute(from))
          throw new DetailedError('from must be an absolute path — the panel would resolve a relative one against its own directory', { statusCode: 400, code: 'FROM_NOT_ABSOLUTE' })
        const include = c.req.valid('query').include?.split(',').filter(part => part.length > 0)
        const exclude = c.req.valid('query').exclude?.split(',').filter(part => part.length > 0)
        return c.json(await deps.backups.restore(from, { confirm, password: c.req.valid('query').password, include, exclude }))
      },
    )
}

/**
 * Every server's live reading, flattened across workspaces.
 *
 * Built from the same views the state frame publishes, so the CLI and the page cannot disagree
 * about what a server is using. A reading is copied as a **value**: an entry with no sample omits
 * the key rather than sending `0`, because a `0` on a CPU gauge reads as "idle" and hides a server
 * the sampler is not measuring at all.
 */
function buildUsage(deps: AppDeps): { servers: Array<Record<string, unknown>>, sampledAt?: number } {
  const state = deps.panel.getState()
  const servers = state.workspaces.flatMap(workspace => workspace.servers.map((server) => {
    const resources = server.resources
    // The window's behaviour, from the same `ServerView.history` the page reads — a live snapshot
    // cannot say "this has restarted nine times in the last hour", which is what a flapping entry
    // looks like from a terminal.
    const history = server.history
    return {
      id: server.id,
      workspaceId: server.workspaceId ?? workspace.id,
      label: server.config.label ?? server.id,
      status: server.status,
      ...(resources?.cpuPercent == null ? {} : { cpuPercent: resources.cpuPercent }),
      ...(resources?.rssBytes == null ? {} : { rssBytes: resources.rssBytes }),
      ...(resources == null ? {} : { processes: resources.processes, sampledAt: resources.sampledAt }),
      ...(history == null
        ? {}
        : {
            restarts: history.restarts,
            crashes: history.crashes,
            ...(history.uptimeRatio == null ? {} : { uptimeRatio: history.uptimeRatio }),
            ...(history.lastExitAt == null ? {} : { lastExitAt: history.lastExitAt }),
          }),
    }
  }))
  return {
    servers,
    ...(state.host.sampledAt == null ? {} : { sampledAt: state.host.sampledAt }),
  }
}
