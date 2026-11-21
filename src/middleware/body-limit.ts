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
     * **`hono/body-limit` cannot be used here, and the reason is worth keeping.**
     *
     * It re-wraps the request to re-read the stream — `c.req.raw = new Request(c.req.raw, init)` — and
     * against srvx the raw request carries a *relative* URL, so that constructor throws
     * `TypeError: Failed to parse URL from [object Request]` with `[cause]: Invalid URL`. Every bodiless
     * `POST` then answers **500**: `start`, `stop`, `backup create`. The unit tests never saw it because
     * the fixture builds a plain `Request` with an absolute URL, where the rewrap succeeds — verified
     * both ways, which is why the guard is written against the header instead.
     *
     * A declared `content-length` over the ceiling is refused before a byte of body is read, which is
     * the case that matters: a browser or `curl -d` always sets it. A chunked request has no length to
     * check up front; it is bounded by the routes that parse it (ArkType rejects a field over its own
     * limits) and by the 1 MB being far above any real body, so this is a guard rather than a sandbox.
     */
    /**
     * **Only the declared length is checked, and that is a deliberate limit.**
     *
     * A `content-length` over the ceiling is refused before a byte of body is read. Every real client
     * sets it: a browser form, `curl -d`, and — checked in `src/shared/api-client.ts` — every `fetch`
     * with a `JSON.stringify` body, which undici and browsers both send with a computed length.
     *
     * A **chunked** body declares no length, and this guard does not count it. Counting means consuming
     * the stream, and every way of doing that here either throws or hangs:
     *
     *  - `hono/body-limit` re-wraps the request (`new Request(c.req.raw, init)`) to re-read it. Against
     *    srvx the raw request carries a *relative* URL, so that constructor throws
     *    `Failed to parse URL from [object Request]` — and **every bodiless `POST` answered 500**.
     *  - Teeing the body and draining one branch hung the request outright rather than refusing it.
     *
     * Both were driven against a built panel, not reasoned about. So the residual gap is a deliberately
     * chunked oversized body, which an authenticated admin has to construct by hand — and someone who
     * can do that can equally send a thousand well-sized requests. The threat this guards against is a
     * typo, a runaway script, or a paste of the wrong file, and all three carry a length.
     */
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
