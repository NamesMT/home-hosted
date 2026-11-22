import type { Context } from 'hono'
import type { AuthService } from '#src/services/auth'
import { streamSSE } from 'hono/streaming'
import { frameKey, sseChannel } from '#src/helpers/sse'
import { accessRefusal, requestIdentity } from '#src/middleware/auth'

const PING_INTERVAL_MS = 15_000

/**
 * The `retry:` hint a stream opens with, in ms — how long a browser waits before reconnecting.
 *
 * It is sent **once, on the opening frame**, and never on a later one: the SSE field sets the
 * reconnection time for the connection, so repeating it on every frame is noise, and a value that
 * changed mid-stream would move the delay under a client that already read one.
 */
const RETRY_HINT_MS = 3_000

/** Anything the hub publishes or a route sends first: `type` names the SSE event. */
export interface StreamFrame { type: string, workspaceId?: string, serverId?: string }

/** How a stream numbers its frames, and where it resumes from. */
export interface StreamResumeOptions {
  /** The last sequence the client already has; `null` for a fresh stream. */
  since?: number | null
  /**
   * The panel's current sequence, for a frame the route builds itself (the opening snapshot).
   *
   * The snapshot's `id:` is the sequence it *describes*, not a newly allocated one: `hello` is "state
   * as of N", so a replay of frames published at or before N follows it without the client's
   * last-event id jumping forward past frames it has not been sent yet.
   */
  currentSeq: () => number
}

/**
 * The one way a route serves server-sent events.
 *
 * The auth guard only sees the request that *opens* a stream, so a stream also re-asks the guard's
 * own question (`accessRefusal`) on every ping and whenever a credential changes — a sign-out, a
 * password set, changed or cleared, a token rotated — and ends the moment the answer is no. The
 * re-check never slides the session: an open tab must not keep an idle session alive past the
 * cookie its browser holds. The client's reconnect then meets the guard's `401`.
 *
 * `start` subscribes and sends the opening frames; it returns its unsubscribe. It is handed `send`,
 * which carries each frame's `id:`, and `resumeFrom`, the sequence a resuming client last saw.
 */
export function serveEventStream(
  c: Context,
  auth: AuthService,
  start: (send: (message: StreamFrame, seq?: number) => void, resumeFrom: number | null) => () => void,
  options: StreamResumeOptions,
): Response {
  return streamSSE(c, async (stream) => {
    const channel = sseChannel(stream)
    const resumeFrom = options.since ?? null
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

    let opened = false
    /**
     * Every frame carries an `id:`, so a client can resume from the last one it saw.
     *
     * **Resumed frames stay monotonic.** A replayed frame keeps its original sequence, and the
     * opening snapshot is numbered at the **resume point** rather than at the panel's current
     * sequence — because the replay that follows it is older than "now". Numbering the snapshot
     * ahead of the replay would hand the client an id it has not actually been sent past, so its
     * `Last-Event-ID` would jump forward and then backwards, and every reconnect would re-deliver
     * log lines it already held. Read as a cursor, the snapshot's id says exactly the right thing:
     * "you have seen everything up to here; here is current state; now here is what came after".
     *
     * A fresh stream numbers its snapshot at the current sequence, so live frames continue above it.
     */
    const send = (message: StreamFrame, seq?: number): void => {
      const id = seq ?? resumeFrom ?? options.currentSeq()
      // `retry:` rides the opening frame only; see `RETRY_HINT_MS`.
      const retry = opened ? undefined : RETRY_HINT_MS
      opened = true
      channel.send(message.type, serializeFrame(message), {
        key: frameKey(message),
        droppable: message.type === 'log',
        id,
        ...(retry === undefined ? {} : { retry }),
      })
    }
    const unsubscribe = start(send, resumeFrom)

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
        // A keep-alive carries the current sequence: it moves nothing and claims nothing.
        channel.send('ping', String(Date.now()), { key: 'ping', id: options.currentSeq() })
      }
    }
    finally {
      stopWatchingAuth()
      unsubscribe()
    }
  })
}

/**
 * Where a stream resumes from: `?since=` when a `fetch`-based reader names one, otherwise the
 * `Last-Event-ID` header an `EventSource` re-sends by itself on reconnect.
 *
 * The query wins when both are present, because it is the one a caller wrote on purpose. Neither is
 * trusted to be a number: a malformed `Last-Event-ID` is ignored rather than resumed from `NaN`,
 * which would replay the whole buffer to a client that asked for nothing.
 */
export function resumePoint(c: Context, querySince?: number): number | null {
  if (querySince !== undefined)
    return Math.max(0, querySince)
  const header = c.req.header('last-event-id')
  if (header === undefined)
    return null
  const trimmed = header.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null
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
