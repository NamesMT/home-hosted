import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { ValidationTargets } from 'hono'
import { DetailedError } from '@namesmt/utils'
import { validator as standardValidator } from 'hono-openapi'

/**
 * ArkType-backed request validation. On success Hono stores the *parsed* value,
 * so `c.req.valid('json')` is fully typed and already normalized; on failure it
 * becomes a `DetailedError`, which the global error handler turns into the one
 * error envelope this API speaks.
 */
export function validate<Target extends keyof ValidationTargets, Schema extends StandardSchemaV1>(target: Target, schema: Schema) {
  return standardValidator(target, schema, (result) => {
    if (result.success === false)
      throw new DetailedError('validation failed', { statusCode: 400, detail: normalizeIssues(result.error) })
  })
}

/** ArkType issues serialize poorly, so only the fields a client can act on survive. */
function normalizeIssues(error: StandardSchemaV1.FailureResult['issues']): Array<{ path: string, message: string }> {
  return error.map((issue) => {
    const path = (issue.path ?? [])
      .map(segment => (typeof segment === 'object' && segment !== null && 'key' in segment ? String(segment.key) : String(segment)))
      .join('.')
    return { path, message: issue.message }
  })
}
