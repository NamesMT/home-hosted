import type { Context } from 'hono'
import type { AppDeps } from '#src/app'
import { DetailedError } from '@namesmt/utils'
import { describeRoute } from 'hono-openapi'
import { statusForAction } from '#src/helpers/action-result'
import { afterResponse } from '#src/helpers/deferred'
import { appFactory } from '#src/helpers/factory'
import { logger } from '#src/helpers/logger'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { secretEqual } from '#src/helpers/secret-compare'
import { validate } from '#src/helpers/validator'
import { requireWorkspace, workspaceQuerySchema } from '#src/helpers/workspace'
import { isLoopbackRequest } from '#src/middleware/loopback'
import { selectionOf } from '#src/services/backups'
import { buildBackupsView } from '#src/services/state'
import { backupCreatedResponseSchema, backupsViewSchema, okResponseSchema, restorePlanSchema } from '#src/shared/contracts'

/**
 * The local control channel used by `home-hosted down` and `home-hosted start|stop`.
 *
 * It is deliberately outside `/api` (so no session is needed) and guarded by a
 * token that only the owner of `run.json` can read, plus a loopback check: a
 * different local user, or anyone on the network, gets nothing.
 */
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

  return appFactory.createApp()
    .post(
      '/shutdown',
      describeRoute({
        tags: ['panel'],
        summary: 'Stop the panel and everything it supervises (local token required)',
        responses: { 200: { description: 'Stopping', content: jsonBody(okResponseSchema) }, 403: { description: 'Bad token, or not a local caller' } },
      }),
      (c) => {
        assertLocalCall(c, 'stop the control panel')

        // Deferred: the answer has to reach `down` before the process goes away.
        afterResponse(deps.onShutdown, error => logger.error('shutdown failed', error))

        return c.json({ ok: true })
      },
    )

    .post(
      '/servers/:id/start',
      describeRoute({
        tags: ['panel'],
        summary: 'Start one server, without a session (local token required)',
        responses: { 200: { description: 'Started', content: jsonBody(okResponseSchema) }, 403: { description: 'Bad token, or not a local caller' }, 404: { description: 'No such server' } },
      }),
      validate('query', workspaceQuerySchema),
      async (c) => {
        assertLocalCall(c, 'start or stop a server')
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const result = await runtime.supervisor.start(c.req.param('id'), { actor: 'user' })
        return c.json(result, statusForAction(result))
      },
    )

    .post(
      '/servers/:id/stop',
      describeRoute({
        tags: ['panel'],
        summary: 'Stop one server, without a session (local token required)',
        responses: { 200: { description: 'Stopped', content: jsonBody(okResponseSchema) }, 403: { description: 'Bad token, or not a local caller' }, 404: { description: 'No such server' } },
      }),
      validate('query', workspaceQuerySchema),
      async (c) => {
        assertLocalCall(c, 'start or stop a server')
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const result = await runtime.supervisor.stop(c.req.param('id'))
        return c.json(result, statusForAction(result))
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
        responses: { 200: { description: 'Restarted', content: jsonBody(okResponseSchema) }, 403: { description: 'Bad token, or not a local caller' }, 404: { description: 'No such server' } },
      }),
      validate('query', workspaceQuerySchema),
      async (c) => {
        assertLocalCall(c, 'restart a server')
        const runtime = requireWorkspace(deps.panel.requireWorkspace.bind(deps.panel), c.req.valid('query').workspace)
        const result = await runtime.supervisor.restart(c.req.param('id'), { actor: 'user' })
        return c.json(result, statusForAction(result))
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
        responses: { 200: { description: 'The archives', content: jsonBody(backupsViewSchema) }, 403: { description: 'Bad token, or not a local caller' } },
      }),
      (c) => {
        assertLocalCall(c, 'list backups')
        return c.json(buildBackupsView(deps.backups))
      },
    )

    .post(
      '/backups',
      describeRoute({
        tags: ['panel'],
        summary: 'Create a backup archive (local token required)',
        responses: { 200: { description: 'Created', content: jsonBody(backupCreatedResponseSchema) }, 400: ERROR_RESPONSES[400], 403: { description: 'Bad token, or not a local caller' } },
      }),
      async (c) => {
        assertLocalCall(c, 'create a backup')
        // Query, not body: the local channel's request helper sends no payload, and `workspace`
        // already travels this way. The password is in the URL on loopback only, which is the same
        // trust boundary as the token in the header.
        const password = c.req.query('password')
        const include = c.req.query('include')?.split(',').filter(part => part.length > 0)
        const exclude = c.req.query('exclude')?.split(',').filter(part => part.length > 0)
        // Without `confirm` this answers the plan and writes nothing, so a script can read what a
        // backup would capture before taking one.
        if (c.req.query('confirm') !== 'true') {
          const view = buildBackupsView(deps.backups)
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
          return c.json({ apply: false, entries, includePaths: view.includePaths })
        }
        const result = await deps.backups.create({ password, include, exclude })
        if (!result.ok)
          throw new DetailedError(result.error ?? 'the backup failed', { statusCode: 400, code: 'BACKUP_FAILED' })
        return c.json({ file: result.file, files: deps.backups.list() })
      },
    )

    .post(
      '/backups/restore',
      describeRoute({
        tags: ['panel'],
        summary: 'Plan or apply a restore from a stored archive (local token required)',
        responses: { 200: { description: 'The plan', content: jsonBody(restorePlanSchema) }, 400: ERROR_RESPONSES[400], 403: { description: 'Bad token, or not a local caller' }, 404: ERROR_RESPONSES[404] },
      }),
      async (c) => {
        assertLocalCall(c, 'restore a backup')
        const confirm = c.req.query('confirm') === 'true'
        const name = c.req.query('name')
        if (name === undefined || name.length === 0)
          throw new DetailedError('name is required', { statusCode: 400, code: 'MISSING_NAME' })
        // `resolve` is the allowlist: it refuses anything that is not a plain archive name.
        const archive = deps.backups.resolve(name)
        if (archive === null)
          throw new DetailedError(`no backup named "${name}"`, { statusCode: 404, code: 'BACKUP_NOT_FOUND' })
        // `include` narrows the restore to the named items. Dropping it silently turned a subset
        // restore into a full one, which writes more over live data than was asked for.
        const include = c.req.query('include')?.split(',').filter(part => part.length > 0)
        const exclude = c.req.query('exclude')?.split(',').filter(part => part.length > 0)
        return c.json(await deps.backups.restore(archive, { confirm, password: c.req.query('password'), include, exclude }))
      },
    )
}
