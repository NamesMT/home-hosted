import type { StandardSchemaV1 } from '@standard-schema/spec'
import { resolver } from 'hono-openapi'
import { apiErrorSchema } from '#src/shared/contracts'

/**
 * A JSON response body for `describeRoute`. The resolver needs a real Standard
 * Schema, so only ArkType schemas go in here — never a hand-written JSON schema.
 */
export function jsonBody(schema: StandardSchemaV1) {
  return { 'application/json': { schema: resolver(schema as never) } }
}

/** The envelope every failing request gets (see `src/helpers/error.ts`). */
export const ERROR_RESPONSES = {
  400: { description: 'The request was rejected', content: jsonBody(apiErrorSchema) },
  401: { description: 'No valid session', content: jsonBody(apiErrorSchema) },
  404: { description: 'Unknown id', content: jsonBody(apiErrorSchema) },
} as const
