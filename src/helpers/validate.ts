import type { StandardSchemaV1 } from '@standard-schema/spec'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'

/**
 * Validates a value that is not a request target (a query string, a URL
 * parameter, a payload read by hand) and fails with the standard error envelope.
 * Request bodies and queries that a route reads once go through the `validate()`
 * middleware instead, which also carries the type into the handler.
 */
export function parseOrThrow<T>(schema: (input: unknown) => unknown, input: unknown, label: string): T {
  const result = schema(input)
  if (result instanceof type.errors) {
    throw new DetailedError(`${label}: ${result.summary}`, {
      statusCode: 400,
      code: 'INVALID_INPUT',
      detail: result.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
    })
  }
  return result as T
}

/** ArkType is a Standard Schema, so the middleware accepts it as-is. */
export type ValidatorSchema = StandardSchemaV1
