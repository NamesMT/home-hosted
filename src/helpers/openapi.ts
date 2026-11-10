import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { ResolverReturnType } from 'hono-openapi'
import { resolver } from 'hono-openapi'
import { apiErrorSchema } from '#src/shared/contracts'

/**
 * A JSON response body for `describeRoute`. The resolver needs a real Standard
 * Schema, so only ArkType schemas go in here — never a hand-written JSON schema.
 */
export function jsonBody(schema: StandardSchemaV1): { 'application/json': { schema: ResolverReturnType } } {
  return { 'application/json': { schema: resolver(schema as never) } }
}

/**
 * A documented failure. `content` is read when a route is described, not when this module loads:
 * `resolver()` builds the schema it is handed, and a module-level call would build it on import.
 */
function errorResponse(description: string): { description: string, readonly content: ReturnType<typeof jsonBody> } {
  return {
    description,
    get content() {
      return jsonBody(apiErrorSchema)
    },
  }
}

/** The envelope every failing request gets (see `src/helpers/error.ts`). */
export const ERROR_RESPONSES = {
  400: errorResponse('The request was rejected'),
  401: errorResponse('No valid session'),
  404: errorResponse('Unknown id'),
  409: errorResponse('The config file was edited on disk since the panel read it (`CONFIG_CHANGED_ON_DISK`); the panel reloads it — retry'),
  413: errorResponse('The body is larger than this route accepts'),
} as const
