import type { AppType } from '@server/app'
import { hc } from 'hono/client'

/**
 * Typed RPC client for the panel API. The server app is chained on purpose (see
 * `src/app.ts`), so every route's path, body and response are inferred here — a
 * changed DTO becomes a compile error in the UI instead of a runtime surprise.
 *
 * The hand-written `api.ts` wrappers stay for streaming endpoints (SSE) and for
 * responses that are validated with ArkType at runtime; this is the ergonomic
 * alternative for the plain JSON calls.
 */
export const rpc = hc<AppType>(typeof window === 'undefined' ? 'http://127.0.0.1' : window.location.origin)
