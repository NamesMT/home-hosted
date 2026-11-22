import type { MiddlewareHandler } from 'hono'
import { DetailedError } from '@namesmt/utils'

/**
 * The ceiling on a JSON request body, panel-wide. Without it a large `POST` becomes a stored config the
 * panel then rebuilds into the frame every second — 1 MB is two orders of magnitude above any real
 * request.
 *
 * The backup-restore upload and the UI zip declare their own larger limit and are exempted by path here,
 * because a plain `use('/api/*')` runs before them.
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
     * A chunked body is refused: its size cannot be known without reading it, and the ways to read it
     * here do not work — `hono/body-limit` re-wraps the request and srvx's `PatchedRequest` throws on
     * rewrap, answering `500` for every bodiless `POST`. `transfer-encoding`, not the presence of a
     * body, is the discriminator, because srvx gives every request a body stream.
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

/**
 * The same ceiling, for a **route that carries a file**, without `bodyLimit`.
 *
 * `hono/body-limit` cannot be used anywhere in this panel: it re-wraps the request to re-read its
 * stream, and srvx's `PatchedRequest` constructor unwraps `_request` before `super(...)`, whose URL is
 * relative — `Failed to parse URL`, a 500. **That is true per-route too, not only at `/api/*`**: the
 * upload routes looked fine because a normal upload carries `content-length` and takes the header
 * fast-path, never reaching the rewrap. A chunked upload answered **500** with the identical stack.
 *
 * So this counts the stream without touching `c.req.raw`: a `TransformStream` sits in front of the one
 * the handler wants, and the count aborts the request the moment it crosses the ceiling. The handler is
 * handed a `Request` built around the measured side, which is exactly what `parseBody()` will read.
 */
export function createBodyCeiling(
  maxBytes: number,
  message = `the upload is larger than ${Math.round(maxBytes / 1024 / 1024)}MB`,
  // The route names its own code: an upload and a login are both bounded here, and one code cannot
  // describe both without reading wrong on one of them.
  code = 'UPLOAD_TOO_LARGE',
): MiddlewareHandler {
  return async (c, next) => {
    const declared = c.req.header('content-length')
    // The cheap answer, and the one a browser upload always allows.
    if (declared !== undefined) {
      const length = Number.parseInt(declared, 10)
      if (Number.isFinite(length) && length > maxBytes) {
        throw new DetailedError(message, { statusCode: 413, code })
      }
      return next()
    }

    const body = c.req.raw.body
    if (body === null)
      return next()

    // Count as the body flows. `tee()` is not used: the copy the handler reads has to stay the only
    // one, or `parseBody()` sees two consumers and one of them stalls.
    let size = 0
    let aborted = false
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength
        if (size > maxBytes) {
          // `controller.error()` surfaces as a bare 500 — nothing turns a stream error into a status, so
          // the flag is set and the refusal raised by this middleware below the `next()`.
          aborted = true
          controller.error(new Error('the upload exceeded its ceiling'))
          return
        }
        controller.enqueue(chunk)
      },
    })

    c.req.raw = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: body.pipeThrough(counter),
      duplex: 'half',
    } as RequestInit)

    const refuse = (): never => {
      throw new DetailedError(message, { statusCode: 413, code })
    }

    try {
      await next()
    }
    catch (error) {
      // The counter errored mid-stream: that is the ceiling firing, and it must answer `413` rather
      // than the bare `500` a stream error becomes on its own.
      if (aborted)
        refuse()
      throw error
    }
    // A handler that returned without consuming the stream still crossed the ceiling.
    if (aborted)
      refuse()
  }
}
