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

/**
 * An `text/event-stream` response, described well enough for a generated client.
 *
 * A stream was documented as `{ description: 'text/event-stream' }` and nothing else: no media type
 * (so a generator emitted a JSON response and a caller parsed a stream as JSON), and no shape for
 * the frames. Both halves are here:
 *
 * - the media type, so the client knows what it is reading;
 * - a `oneOf` over the frame shapes with `discriminator: type`, which is what lets a generator emit
 *   a discriminated union. `x-sse-events` names the `event:` labels beside it, because OpenAPI has no
 *   way to say "the `event:` line selects the shape" — the field is an extension by design and a
 *   generic client ignores it.
 *
 * The frame schemas are the contract's own (`sseMessageSchema` renders them through the same
 * pipeline, and `finishSpec` lifts each into `components.schemas`), so this describes the frames
 * that are actually sent rather than a second hand-written copy.
 */
export function sseResponse(description: string, events: readonly string[] = ['hello', 'state', 'server', 'log', 'ping']) {
  return {
    description,
    'content': {
      'text/event-stream': {
        schema: {
          oneOf: [
            { $ref: '#/components/schemas/SseStateFrame' },
            { $ref: '#/components/schemas/SseServerFrame' },
            { $ref: '#/components/schemas/SseLogFrame' },
            { $ref: '#/components/schemas/SsePingFrame' },
          ],
          discriminator: {
            propertyName: 'type',
            mapping: {
              hello: '#/components/schemas/SseStateFrame',
              state: '#/components/schemas/SseStateFrame',
              server: '#/components/schemas/SseServerFrame',
              log: '#/components/schemas/SseLogFrame',
              ping: '#/components/schemas/SsePingFrame',
            },
          },
        } as unknown as Record<string, unknown>,
      },
    },
    /** The `event:` labels this stream emits, in the order a client sees them the first time. */
    'x-sse-events': events,
  } as const
}

/**
 * A `multipart/form-data` body carrying one file part, for `requestBody`.
 *
 * Two upload routes (`POST /api/settings/ui`, and the restore's archive) read a `file` part and
 * documented no body at all — so a client generated from the spec could not call them. `required`
 * names it, because a request without it is a `400 MISSING_FILE`, not a valid empty upload.
 */
export const multipartFileBody = {
  type: 'object',
  properties: {
    file: { type: 'string', format: 'binary', description: 'the archive to install' },
  },
  required: ['file'],
} as unknown as Record<string, unknown> & { type: 'object' }

/** The envelope every failing request gets (see `src/helpers/error.ts`). */
export const ERROR_RESPONSES = {
  400: errorResponse('The request was rejected'),
  401: errorResponse('No valid session'),
  404: errorResponse('Unknown id'),
  409: errorResponse('The config file was edited on disk since the panel read it (`CONFIG_CHANGED_ON_DISK`); the panel reloads it — retry'),
  413: errorResponse('The body is larger than this route accepts'),
} as const
