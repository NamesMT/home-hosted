import type { Context } from 'hono'
import type { AppDeps } from '#src/app'
import path from 'node:path'
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
import { buildBackupsView } from '#src/services/state'
import { selectionOf } from '#src/shared/backup-scope'
import { backupCreatedResponseSchema, backupsViewSchema, freePortResultSchema, okResponseSchema, restorePlanSchema } from '#src/shared/contracts'

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
        summary: 'Plan or apply a restore from a stored archive or a file on this machine (local token required)',
        responses: { 200: { description: 'The plan', content: jsonBody(restorePlanSchema) }, 400: ERROR_RESPONSES[400], 403: { description: 'Bad token, or not a local caller' }, 404: ERROR_RESPONSES[404] },
      }),
      async (c) => {
        assertLocalCall(c, 'restore a backup')
        const confirm = c.req.query('confirm') === 'true'
        const name = c.req.query('name')
        const from = c.req.query('from')
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
          const include = c.req.query('include')?.split(',').filter(part => part.length > 0)
          const exclude = c.req.query('exclude')?.split(',').filter(part => part.length > 0)
          return c.json(await deps.backups.restore(archive, { confirm, password: c.req.query('password'), include, exclude }))
        }

        // Absolute only: this process's working directory is not the caller's, so a relative path
        // would silently read a different file than the one the person typed.
        if (!path.isAbsolute(from))
          throw new DetailedError('from must be an absolute path — the panel would resolve a relative one against its own directory', { statusCode: 400, code: 'FROM_NOT_ABSOLUTE' })
        const include = c.req.query('include')?.split(',').filter(part => part.length > 0)
        const exclude = c.req.query('exclude')?.split(',').filter(part => part.length > 0)
        return c.json(await deps.backups.restore(from, { confirm, password: c.req.query('password'), include, exclude }))
      },
    )
}
