/**
 * The SSE frames, and the one place that derives the `event:` names from them.
 *
 * Each frame is a schema the published spec names: `GET /api/events` describes its `text/event-stream`
 * body as a `oneOf` over these with `discriminator: type`. They are the same schemas the panel sends, so
 * the document cannot describe a frame the server does not produce.
 */
import { type } from 'arktype'
import { appStateSchema, logLineSchema, serverViewSchema } from '../contracts'
import { lazy } from '../lazy'

/**
 * One SSE frame, discriminated by `type`: a client narrowing on it gets the payload that frame carries.
 *
 * Each frame is exported because the published spec names them: `GET /api/events` describes its
 * `text/event-stream` body as a `oneOf` over these with `discriminator: type`, which is what lets a
 * generated client emit a discriminated union instead of `unknown`. They are the same schemas the
 * panel sends, so the document cannot describe a frame the server does not produce.
 */
export const sseStateFrameSchema = lazy(() => type({
  type: '"hello" | "state"',
  ts: 'number',
  state: appStateSchema,
}).onDeepUndeclaredKey('ignore'))
export const sseServerFrameSchema = lazy(() => type({
  'type': '"server"',
  'ts': 'number',
  'workspaceId?': 'string',
  'serverId': 'string',
  'server': serverViewSchema,
}).onDeepUndeclaredKey('ignore'))
export const sseLogFrameSchema = lazy(() => type({
  'type': '"log"',
  'ts': 'number',
  'workspaceId?': 'string',
  'serverId': 'string',
  'lines': logLineSchema.array(),
}).onDeepUndeclaredKey('ignore'))
/**
 * The keep-alive. It carries no payload — a stream that says nothing for 30 s is closed by proxies
 * between the panel and a browser, so `ping` exists to keep the connection visibly alive.
 */
export const ssePingFrameSchema = lazy(() => type({
  type: '"ping"',
  ts: 'number',
}).onDeepUndeclaredKey('ignore'))
/**
 * Every `event:` name this build's streams can send, derived from the frame schemas so `GET /api/meta`
 * cannot drift from what is actually sent.
 *
 * A function, not a module-level constant: computing it at import materialises the `lazy()` schemas,
 * which is what `test/shared/lazy.test.ts` forbids.
 */
/** Cached after the first call: the answer is a property of the schemas, and `/api/meta` is a request path. */
let sseEventNamesCache: string[] | null = null
export function sseEventNames(): string[] {
  if (sseEventNamesCache !== null)
    return sseEventNamesCache
  sseEventNamesCache = [
    ...new Set([sseStateFrameSchema, sseServerFrameSchema, sseLogFrameSchema, ssePingFrameSchema]
      .flatMap((schema) => {
        /**
         * A single-literal field renders as `const`, a union as `enum` — and the frames use both
         * (`'"server"'` against `'"hello" | "state"'`). Reading only `enum` collected two of five names,
         * which is exactly the drift this derivation exists to prevent.
         */
        const type = (schema.toJsonSchema() as { properties?: { type?: { const?: string, enum?: string[] } } })
          .properties
          ?.type
        return type?.enum ?? (type?.const === undefined ? [] : [type.const])
      })),
  ].sort()
  return sseEventNamesCache
}

export const sseMessageSchema = lazy(() => sseStateFrameSchema.or(sseServerFrameSchema).or(sseLogFrameSchema).or(ssePingFrameSchema))
export type SseMessage = typeof sseMessageSchema.infer
