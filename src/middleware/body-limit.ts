import type { MiddlewareHandler } from 'hono'
import { DetailedError } from '@namesmt/utils'

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
  return async (c, next) => {
    // A route that carries a file declares its own ceiling, and it is the only one that knows what
    // "too large" means for an archive. Matched on the path because a middleware installed at
    // `/api/*` runs before any route-level one and there is no cheaper way to ask.
    const pathname = new URL(c.req.url, 'http://localhost').pathname
    if (carriesAnUpload(c.req.method, pathname))
      return next()

    /**
     * **A chunked body is refused**, because its size cannot be known without reading it.
     *
     * That gap was real, not theoretical. The guard originally checked only `content-length`, and a
     * hand-built `Transfer-Encoding: chunked` `POST` carrying a 3 MB `command` was accepted (`201`) and
     * written to `servers.config.json` — **3 000 304 bytes**, making the state frame **3 005 852
     * bytes**. The same DoS the guard exists to prevent, through the one door it left open.
     *
     * Counting the stream instead is not available here, and both ways were driven against a built
     * panel rather than reasoned about:
     *
     *  - `hono/body-limit` re-wraps the request (`new Request(c.req.raw, init)`) to re-read it, and
     *    against srvx the raw request carries a *relative* URL, so that constructor throws
     *    `Failed to parse URL from [object Request]`. Mounted at `/api/*` it answered **500 for every
     *    bodiless `POST`** — `start`, `stop`, `backup create`. (Per-route, as the upload handlers do, it
     *    works; why the two differ is not something I established.)
     *  - Teeing the body and draining one branch hung the request rather than refusing it.
     *
     * So what cannot be measured is refused: `411 LENGTH_REQUIRED`. **`transfer-encoding` is the
     * discriminator, not the presence of a body** — srvx gives every request a body stream, so a
     * bodiless `POST` and a chunked one are identical by that measure, and only the chunked one carries
     * the header.
     */
    if (c.req.header('transfer-encoding') !== undefined) {
      throw new DetailedError(
        'a request body must declare its length — a chunked body cannot be size-checked',
        { statusCode: 411, code: 'LENGTH_REQUIRED' },
      )
    }

    const declared = c.req.header('content-length')
    if (declared === undefined)
      return next()

    const length = Number.parseInt(declared, 10)
    if (Number.isFinite(length) && length > MAX_JSON_BODY_BYTES) {
      throw new DetailedError(
        `the request body is larger than ${Math.round(MAX_JSON_BODY_BYTES / 1024)} KB`,
        { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' },
      )
    }
    return next()
  }
}

/** The two routes whose body is a file rather than JSON, each with its own larger limit. */
function carriesAnUpload(method: string, pathname: string): boolean {
  if (method !== 'POST')
    return false
  return pathname === '/api/backups/restore' || pathname === '/api/settings/ui'
}
