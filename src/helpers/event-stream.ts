import type { Context } from 'hono'
import type { AuthService } from '#src/services/auth'
import { streamSSE } from 'hono/streaming'
import { frameKey, sseChannel } from '#src/helpers/sse'
import { accessRefusal, requestIdentity } from '#src/middleware/auth'

export const PING_INTERVAL_MS = 15_000

/** Anything the hub publishes or a route sends first: `type` names the SSE event. */
export interface StreamFrame { type: string, workspaceId?: string, serverId?: string }

/**
 * The one way a route serves server-sent events.
 *
 * The auth guard only sees the request that *opens* a stream, so a stream also re-asks the guard's
 * own question (`accessRefusal`) on every ping and whenever a credential changes — a sign-out, a
 * password set, changed or cleared, a token rotated — and ends the moment the answer is no. The
 * re-check never slides the session: an open tab must not keep an idle session alive past the
 * cookie its browser holds. The client's reconnect then meets the guard's `401`.
 *
 * `start` subscribes and sends the opening frames; it returns its unsubscribe.
 */
export function serveEventStream(
  c: Context,
  auth: AuthService,
  start: (send: (message: StreamFrame) => void) => () => void,
): Response {
  return streamSSE(c, async (stream) => {
    const channel = sseChannel(stream)
    let wake: (() => void) | null = null
    const end = (): void => {
      channel.close()
      wake?.()
    }

    const recheck = (): void => {
      if (!channel.closed && accessRefusal(c, auth, requestIdentity(c, auth, { slide: false })) !== null)
        end()
    }
    const stopWatchingAuth = auth.onCredentialsChanged(recheck)
    stream.onAbort(end)

    const send = (message: StreamFrame): void => {
      channel.send(message.type, serializeFrame(message), { key: frameKey(message), droppable: message.type === 'log' })
    }
    const unsubscribe = start(send)

    try {
      while (!channel.closed) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, PING_INTERVAL_MS)
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
        wake = null
        recheck()
        channel.send('ping', String(Date.now()), { key: 'ping' })
      }
    }
    finally {
      stopWatchingAuth()
      unsubscribe()
    }
  })
}

/**
 * One serialisation per published frame, however many streams carry it.
 *
 * The hub hands every subscriber the same message object, and the state frame — the whole panel —
 * was stringified once per open tab, every second. A published frame is never mutated afterwards,
 * so its text is remembered against the object and goes when the object does.
 */
const serialized = new WeakMap<object, string>()

export function serializeFrame(message: StreamFrame): string {
  let text = serialized.get(message)
  if (text === undefined) {
    text = JSON.stringify(message)
    serialized.set(message, text)
  }
  return text
}
