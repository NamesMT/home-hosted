import type { AppDeps } from '#src/app'
import type { BackupCreate, RestoreRequest } from '#src/shared/contracts'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { DetailedError } from '@namesmt/utils'
import { describeRoute } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'
import { logger } from '#src/helpers/logger'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { parseOrThrow } from '#src/helpers/validate'
import { validate } from '#src/helpers/validator'
import { buildBackupsView } from '#src/services/state'
import { backupCreateSchema, backupsViewSchema, restorePlanSchema, restoreRequestSchema } from '#src/shared/contracts'

/** Uploads are buffered in memory by `parseBody`, so they get a hard ceiling. */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024

/** A backup that failed to be created is a bad request, not a server fault. */
function backupFailed(error: string | undefined): DetailedError {
  return new DetailedError(error ?? 'the backup failed', { statusCode: 400, code: 'BACKUP_FAILED' })
}

export function createBackupsRoute(deps: AppDeps) {
  return appFactory.createApp()
    .get(
      '/backups',
      describeRoute({
        tags: ['backups'],
        summary: 'Archives on disk, and the paths a backup would capture',
        responses: { 200: { description: 'Backups', content: jsonBody(backupsViewSchema) } },
      }),
      c => c.json(buildBackupsView(deps.store, deps.backups)),
    )

    .post(
      '/backups',
      describeRoute({
        tags: ['backups'],
        summary: 'Create a backup (optionally password-protected)',
        responses: { 200: { description: 'Created' }, 400: ERROR_RESPONSES[400] },
      }),
      validate('json', backupCreateSchema),
      async (c) => {
        const body: BackupCreate = c.req.valid('json')
        const result = await deps.backups.create({ password: body.password })
        if (!result.ok)
          throw backupFailed(result.error)
        return c.json({ file: result.file, files: deps.backups.list() })
      },
    )

    .get(
      '/backups/:name/download',
      describeRoute({
        tags: ['backups'],
        summary: 'Download one archive',
        responses: { 200: { description: 'the archive (application/zip)' }, 404: ERROR_RESPONSES[404] },
      }),
      (c) => {
        const file = deps.backups.resolve(c.req.param('name'))
        if (file === null)
          throw new DetailedError('unknown backup', { statusCode: 404, code: 'UNKNOWN_BACKUP' })

        const stats = fs.statSync(file)
        return c.body(fs.readFileSync(file), 200, {
          'Content-Type': 'application/zip',
          'Content-Length': String(stats.size),
          'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
        })
      },
    )

    .delete(
      '/backups/:name',
      describeRoute({
        tags: ['backups'],
        summary: 'Delete one archive',
        responses: { 200: { description: 'Removed' }, 404: ERROR_RESPONSES[404] },
      }),
      (c) => {
        if (!deps.backups.remove(c.req.param('name')))
          throw new DetailedError('unknown backup', { statusCode: 404, code: 'UNKNOWN_BACKUP' })
        return c.json({ ok: true, files: deps.backups.list() })
      },
    )

    /**
     * Restore from a stored backup (`{ "name": "..." }`) or an uploaded one.
     * Without `confirm` it answers with the plan and changes nothing; `password`
     * unlocks a protected archive and `include` selects the items to apply.
     */
    .post('/backups/restore', describeRoute({
      tags: ['backups'],
      summary: 'Plan or apply a restore from a stored or uploaded archive',
      responses: { 200: { description: 'The plan', content: jsonBody(restorePlanSchema) }, 400: ERROR_RESPONSES[400], 404: ERROR_RESPONSES[404] },
    }), async (c) => {
      const confirm = c.req.query('confirm') === 'true'
      const contentType = c.req.header('content-type') ?? ''

      let archive: string | null = null
      let uploadedTo: string | null = null
      let request: RestoreRequest

      try {
        if (contentType.includes('multipart/form-data')) {
          const declared = Number.parseInt(c.req.header('content-length') ?? '0', 10)
          if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES)
            throw new DetailedError(`the upload is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`, { statusCode: 413, code: 'UPLOAD_TOO_LARGE' })

          const body = await c.req.parseBody()
          const file = body.file
          if (!(file instanceof File))
            throw new DetailedError('expected a `file` field with the archive', { statusCode: 400, code: 'MISSING_FILE' })
          if (file.size > MAX_UPLOAD_BYTES)
            throw new DetailedError(`the upload is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`, { statusCode: 413, code: 'UPLOAD_TOO_LARGE' })

          const uploads = path.join(deps.backups.directory, 'uploads')
          fs.mkdirSync(uploads, { recursive: true })
          uploadedTo = path.join(uploads, `upload-${Date.now()}.zip`)
          fs.writeFileSync(uploadedTo, Buffer.from(await file.arrayBuffer()))
          archive = uploadedTo
          // A multipart body can only carry strings, so the selection is JSON.
          const rawInclude = typeof body.include === 'string' && body.include.length > 0 ? body.include : null
          let include: unknown
          if (rawInclude !== null) {
            try {
              include = JSON.parse(rawInclude)
            }
            catch {
              throw new DetailedError('`include` must be a JSON array of item ids', { statusCode: 400, code: 'INVALID_INCLUDE' })
            }
          }
          request = parseOrThrow<RestoreRequest>(restoreRequestSchema, {
            ...(typeof body.password === 'string' ? { password: body.password } : {}),
            ...(rawInclude === null ? {} : { include }),
          }, 'body')
        }
        else {
          request = parseOrThrow<RestoreRequest>(restoreRequestSchema, await c.req.json().catch(() => ({})), 'body')
          if (request.name === undefined)
            throw new DetailedError('expected a backup name or a file upload', { statusCode: 400, code: 'MISSING_ARCHIVE' })
          archive = deps.backups.resolve(request.name)
          if (archive === null)
            throw new DetailedError('unknown backup', { statusCode: 404, code: 'UNKNOWN_BACKUP' })
        }

        const plan = await deps.backups.restore(archive, {
          confirm,
          password: request.password,
          include: request.include,
        })
        // A wrong or missing password is a prompt, not a failure.
        if (plan.needsPassword)
          return c.json(plan)
        if (plan.error !== undefined)
          throw new DetailedError(plan.error, { statusCode: 400, code: 'RESTORE_FAILED', detail: { items: plan.items, applied: plan.applied, skipped: plan.skipped } })
        if (confirm)
          logger.info(`restored from ${path.basename(archive)}: ${plan.applied.join(', ')}`)

        return c.json(plan)
      }
      finally {
      // An uploaded archive is only needed for this request.
        if (uploadedTo !== null)
          fs.rmSync(uploadedTo, { force: true })
      }
    })
}
