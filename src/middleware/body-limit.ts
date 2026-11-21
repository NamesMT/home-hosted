import type { MiddlewareHandler } from 'hono'
import { DetailedError } from '@namesmt/utils'
import { bodyLimit } from 'hono/body-limit'

/**
 * The ceiling on a JSON request body, panel-wide.
 *
 * **Absent, one `POST` could turn every frame into megabytes.** Measured on a scratch panel: a
 * 19 MB `POST /api/servers` with a 19 MB `command` was accepted (`201`), written to
 * `servers.config.json`, and the state frame then became **20 MB** — a payload the panel builds every
 * second and pushes over SSE to every open tab. The request was authenticated and admin, so this is not
 * an unauthenticated attack; it is a typo, a runaway script, or a paste of the wrong file, and it makes
 * the panel unusable from the moment it lands. `GET /api/settings` and the config editor both have to
 * load the file back, too.
 *
 * **1 MB is generous, measured against what a real request carries**: a server entry is ~400 bytes, so
 * fifty are ~20 KB; a fifty-route proxy table is ~15 KB; a settings `PATCH` with every field set is
 * ~5 KB. The largest legitimate body is two orders of magnitude under this.
 *
 * Two routes legitimately carry more — a backup restore upload and a UI zip — and each declares its own,
 * larger `bodyLimit`. **They are exempted by path here, because a plain `use('/api/*')` runs before them
 * and would refuse a 3 MB backup archive with this 1 MB limit.** Verified the wrong way first: the
 * upload came back `413` until these two were let through.
 */
export const MAX_JSON_BODY_BYTES = 1024 * 1024

/**
 * Refuses an oversized body **before** it is read into memory or parsed.
 *
 * Installed after the auth and scope guards, so an anonymous caller is turned away on identity rather
 * than on a size it never got to send; a session is not held open while a huge body streams in.
 */
export function createBodyLimitGuard(): MiddlewareHandler {
  const limit = bodyLimit({
    maxSize: MAX_JSON_BODY_BYTES,
    onError: () => {
      throw new DetailedError(
        `the request body is larger than ${Math.round(MAX_JSON_BODY_BYTES / 1024)} KB`,
        { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' },
      )
    },
  })
  return async (c, next) => {
    // A route that carries a file declares its own ceiling, and it is the only one that knows what
    // "too large" means for an archive. Matched on the path because a middleware installed at
    // `/api/*` runs before any route-level one and there is no cheaper way to ask.
    if (carriesAnUpload(c.req.method, new URL(c.req.url).pathname))
      return next()
    return limit(c, next)
  }
}

/** The two routes whose body is a file rather than JSON, each with its own larger limit. */
function carriesAnUpload(method: string, pathname: string): boolean {
  if (method !== 'POST')
    return false
  return pathname === '/api/backups/restore' || pathname === '/api/settings/ui'
}
