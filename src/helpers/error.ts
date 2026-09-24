import type { DetailedError } from '@namesmt/utils'
import type { ErrorHandler as HonoErrorHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { HTTPException } from 'hono/http-exception'
import { logger } from '#src/helpers/logger'

/**
 * The one error envelope this API speaks:
 *
 * ```json
 * { "message": "human readable", "code": "MACHINE_READABLE", "detail": … }
 * ```
 *
 * `@namesmt/utils`' `DetailedError` is the preferred way to fail — it carries the
 * status, a stable code and structured detail — so a client (and the OpenAPI
 * schema) can rely on the shape.
 */
export interface ApiErrorBody {
  message: string
  code: string
  detail?: unknown
}

export const errorHandler: HonoErrorHandler = (error, c) => {
  const body = toErrorBody(error)
  const status = statusOf(error)

  if (status >= 500)
    logger.error(`${c.req.method} ${new URL(c.req.url).pathname} failed:`, error)
  else
    logger.debug(`${c.req.method} ${new URL(c.req.url).pathname} → ${status} ${body.message}`)

  return c.json(body, status)
}

function toErrorBody(error: unknown): ApiErrorBody {
  if (error instanceof HTTPException)
    return { message: error.message, code: 'HTTP_EXCEPTION' }

  // `DetailedError` can come from this code or from Hono's own parsing helpers,
  // so a name check is safer than `instanceof` across module instances.
  if (isDetailedError(error)) {
    return {
      message: error.message,
      code: error.code ?? 'DETAILED_ERROR',
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    }
  }

  if (error instanceof Error)
    return { message: error.message, code: error.name === 'Error' ? 'INTERNAL_ERROR' : error.name.toUpperCase() }

  return { message: String(error), code: 'INTERNAL_ERROR' }
}

function isDetailedError(error: unknown): error is DetailedError {
  return error instanceof Error && error.name === 'DetailedError' && 'statusCode' in error
}

function statusOf(error: unknown): ContentfulStatusCode {
  const candidate = (error as { statusCode?: unknown, status?: unknown })?.statusCode ?? (error as { status?: unknown })?.status
  const status = typeof candidate === 'number' ? candidate : 500
  return status >= 400 && status <= 599 ? (status as ContentfulStatusCode) : 500
}
