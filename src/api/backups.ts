import type { AppDeps } from '#src/app'
import type { BackupCreate, RestoreRequest } from '#src/shared/contracts'
import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import fs, { createReadStream } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { describeRoute, resolver } from 'hono-openapi'
import { bodyLimit } from 'hono/body-limit'
import { appFactory } from '#src/helpers/factory'
import { logger } from '#src/helpers/logger'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { parseOrThrow } from '#src/helpers/validate'
import { validate } from '#src/helpers/validator'
import { buildBackupsView } from '#src/services/state'
import { backupCreatedResponseSchema, backupCreateSchema, backupFilesResponseSchema, backupsViewSchema, restorePlanSchema, restoreRequestSchema } from '#src/shared/contracts'

/** Uploads are buffered in memory by `parseBody`, so they get a hard ceiling. */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024

const nameParam = type({ name: 'string >= 1' })

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
      c => c.json(buildBackupsView(deps.backups)),
    )

    .post(
      '/backups',
      describeRoute({
        tags: ['backups'],
        summary: 'Create a backup (optionally password-protected)',
        responses: { 200: { description: 'Created', content: jsonBody(backupCreatedResponseSchema) }, 400: ERROR_RESPONSES[400] },
      }),
      validate('json', backupCreateSchema),
      async (c) => {
        const body: BackupCreate = c.req.valid('json')
        // `include` and `exclude` together are allowed, and mean what the CLI means by them: the
        // exclusion applies after the selection. The pair stays coherent because `create` reads
        // both through one `selectionOf`, and a scope that leaves nothing refuses there rather
        // than writing an empty archive.
        const result = await deps.backups.create({ password: body.password, include: body.include, exclude: body.exclude })
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
      validate('param', nameParam),
      async (c) => {
        const file = deps.backups.resolve(c.req.valid('param').name)
        if (file === null)
          throw new DetailedError('unknown backup', { statusCode: 404, code: 'UNKNOWN_BACKUP' })

        // Streamed, not read into memory. An archive has **no size ceiling** — it carries whatever the
        // declared data paths hold — so `readFileSync` blocked the event loop for the whole read and
        // held it: measured at 82 ms for 100 MB, 841 ms for 500 MB and 1.3 s for 1 GB, with every
        // state frame and health probe waiting.
        //
        // `createReadStream`, not `FileHandle.readableWebStream`: consuming the latter to the end
        // leaves the handle **open** (measured — a `stat()` on it still succeeds), so every download
        // would leak a descriptor. `createReadStream` destroys itself on end *and* on a client that
        // disconnects (measured `destroyed: true`).
        const stats = await fs.promises.stat(file)
        return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream, 200, {
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
        responses: { 200: { description: 'Removed', content: jsonBody(backupFilesResponseSchema) }, 404: ERROR_RESPONSES[404] },
      }),
      validate('param', nameParam),
      (c) => {
        if (!deps.backups.remove(c.req.valid('param').name))
          throw new DetailedError('unknown backup', { statusCode: 404, code: 'UNKNOWN_BACKUP' })
        return c.json({ ok: true, files: deps.backups.list() })
      },
    )

    /**
     * Restore from a stored backup (`{ "name": "..." }`) or an uploaded one.
     * Without `confirm` it answers with the plan and changes nothing; `password`
     * unlocks a protected archive, and `include`/`exclude` select the items to apply.
     *
     * The body is declared so a generated client can send one: this is the only `/api` write route
     * that reads a JSON body, and it was the only one the document gave no `requestBody` — so
     * `openapi-typescript` and Scalar's "try it" produced a restore call with nowhere to put
     * `name`, while the README tells an agent this document *is* the API it may call. An upload is
     * `multipart/form-data` with the same fields as JSON strings, which is why the schema is named
     * but not required.
     */
    .post('/backups/restore', describeRoute({
      tags: ['backups'],
      summary: 'Plan or apply a restore from a stored or uploaded archive',
      requestBody: { required: false, content: { 'application/json': { schema: resolver(restoreRequestSchema) } } },
      responses: { 200: { description: 'The plan', content: jsonBody(restorePlanSchema) }, 400: ERROR_RESPONSES[400], 404: ERROR_RESPONSES[404], 413: ERROR_RESPONSES[413] },
    }),
    /**
     * Bound the body **while it arrives**, not after.
     *
     * The handler's own checks read `Content-Length` first — a header a chunked request simply does
     * not send — and then compare `file.size` after `parseBody()` has already buffered the whole
     * body into memory. So an upload with no length is buffered in full and *then* refused: the
     * ceiling was a memory limit rather than a guard. This middleware counts chunks and aborts at the
     * cap, which is the half the header check cannot do.
     */
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES,
      onError: () => {
        throw new DetailedError(`the upload is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`, { statusCode: 413, code: 'UPLOAD_TOO_LARGE' })
      },
    }), async (c) => {
      const confirm = c.req.query('confirm') === 'true'
      const contentType = c.req.header('content-type') ?? ''

      let archive: string | null = null
      let uploadedTo: string | null = null
      let request: RestoreRequest

      try {
        if (contentType.includes('multipart/form-data')) {
          // `parseInt` is deliberate here and is not the prefix bug it resembles elsewhere: this
          // value is a header Node has already validated. A non-decimal `Content-Length` gets a
          // 400 from the HTTP parser before any handler runs (verified by sending a raw
          // `Content-Length: 1e12`), so the only shapes that arrive are decimal — and a partial
          // parse cannot make an oversized upload pass. This is a pre-flight check anyway; the
          // body is parsed and counted below.
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
          uploadedTo = path.join(uploads, `upload-${crypto.randomUUID()}.zip`)
          // 0600: the archive holds whatever the config declares as data, possibly in
          // the clear, and sits here until the request finishes.
          fs.writeFileSync(uploadedTo, Buffer.from(await file.arrayBuffer()), { mode: 0o600 })
          archive = uploadedTo
          // A multipart body can only carry strings, so each selection is JSON. Both directions are
          // read the same way: `include` and `exclude` are one idea (`selectionOf`) and a body that
          // could carry only one of them made "everything except these" inexpressible on an upload.
          const jsonField = (key: 'include' | 'exclude'): unknown => {
            const raw = typeof body[key] === 'string' && body[key].length > 0 ? body[key] : null
            if (raw === null)
              return undefined
            try {
              return JSON.parse(raw)
            }
            catch {
              throw new DetailedError(`\`${key}\` must be a JSON array of item ids`, { statusCode: 400, code: key === 'include' ? 'INVALID_INCLUDE' : 'INVALID_EXCLUDE' })
            }
          }
          const include = jsonField('include')
          const exclude = jsonField('exclude')
          request = parseOrThrow<RestoreRequest>(restoreRequestSchema, {
            ...(typeof body.password === 'string' ? { password: body.password } : {}),
            ...(include === undefined ? {} : { include }),
            ...(exclude === undefined ? {} : { exclude }),
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
          // The exclusion is what makes "everything but the credentials" expressible over HTTP, the
          // same pair the CLI and the docs recommend: leave the password and token hashes behind.
          exclude: request.exclude,
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
