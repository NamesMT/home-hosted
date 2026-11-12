import type { SseMessage } from '#src/shared/contracts'
import { serverKey } from '#src/shared/server-key'

/**
 * `seq` is the panel-wide sequence number the hub assigns to every published frame: it is what the
 * SSE `id:` line carries, and what a resume (`Last-Event-ID`, `?since=`) addresses.
 */
export type EventListener = (message: SseMessage, seq: number) => void

const ALL = '*'

/**
 * How much is kept for a resume: the last 200 `log` frames, and never more than this many bytes.
 *
 * A slow or long-gone client must not make the panel buffer without bound, and a log frame can be a
 * large batch, so the frame count alone is not a bound — both ceilings apply and the oldest goes
 * first.
 */
const MAX_BUFFERED_FRAMES = 200
const MAX_BUFFERED_BYTES = 256 * 1024

/**
 * Only `log` frames are retained, and that is deliberate.
 *
 * `hello`/`state`/`server` frames are **snapshots**: a resume sends one current one, and replaying an
 * older snapshot after it would regress the state the client just received. Log lines are the one
 * thing a snapshot cannot express, so they are the one thing worth replaying.
 */
const REPLAYABLE = new Set(['log'])

/** A rough byte size, cheap enough for the publish path: only log frames are measured. */
function frameBytes(message: SseMessage): number {
  if (message.type !== 'log')
    return 0
  // Per line: the text plus JSON punctuation and the `{ ts, stream }` around it.
  return message.lines.reduce((sum, line) => sum + line.text.length + 48, 64)
}

/**
 * Fan-out for SSE subscribers, optionally scoped to one server.
 *
 * The scope is `workspaceId/serverId`, never the bare id: server ids are only
 * unique *within* a workspace, so keying on the id alone would deliver one
 * workspace's log lines to a subscriber watching another workspace's server of
 * the same name.
 */
// One definition, in `src/shared`: the UIs subscribe with the same key, and a divergence here would
// route frames to the wrong bucket with nothing to error on. Re-exported so callers are unchanged.
export { serverKey } from '#src/shared/server-key'

export class EventHub {
  private readonly listeners = new Map<string, Set<EventListener>>()
  /** Per panel, not per stream: one counter makes an `id` meaningful across a reconnect. */
  private seq = 0
  private readonly buffer: Array<{ seq: number, message: SseMessage, bytes: number }> = []
  private bufferedBytes = 0

  /** The sequence the panel is at: an opening snapshot is "state as of this sequence". */
  get lastSeq(): number {
    return this.seq
  }

  /** How many frames a resume can still replay. Zero when nothing chatty has been published. */
  get bufferedFrames(): number {
    return this.buffer.length
  }

  /** The oldest sequence still replayable, or `lastSeq` when the buffer is empty. */
  get bufferedFrom(): number {
    return this.buffer[0]?.seq ?? this.seq
  }

  subscribe(key: string | null, listener: EventListener): () => void {
    const bucketKey = key ?? ALL
    const bucket = this.listeners.get(bucketKey) ?? new Set<EventListener>()
    bucket.add(listener)
    this.listeners.set(bucketKey, bucket)

    return () => {
      bucket.delete(listener)
      if (bucket.size === 0)
        this.listeners.delete(bucketKey)
    }
  }

  /**
   * A subscriber that first receives the buffered frames after `since`, then live ones.
   *
   * The replay runs synchronously before the subscription exists, so no frame can land in the gap
   * between them, and the frames arrive in the order they were published. A `since` older than the
   * buffer replays what is retained: the caller's opening snapshot is current, and the log routes
   * hold the full history, so a gap costs log lines rather than state.
   */
  subscribeFrom(key: string | null, since: number, listener: EventListener): () => void {
    for (const entry of this.buffer) {
      if (entry.seq > since && matches(key, entry.message))
        listener(entry.message, entry.seq)
    }
    return this.subscribe(key, listener)
  }

  publish(message: SseMessage): void {
    const seq = ++this.seq
    if (REPLAYABLE.has(message.type))
      this.remember(seq, message)

    this.dispatch(ALL, message, seq)
    if ((message.type === 'server' || message.type === 'log') && message.workspaceId)
      this.dispatch(serverKey(message.workspaceId, message.serverId), message, seq)
  }

  private remember(seq: number, message: SseMessage): void {
    const bytes = frameBytes(message)
    this.buffer.push({ seq, message, bytes })
    this.bufferedBytes += bytes
    while (this.buffer.length > MAX_BUFFERED_FRAMES || this.bufferedBytes > MAX_BUFFERED_BYTES) {
      const dropped = this.buffer.shift()
      if (dropped === undefined)
        break
      this.bufferedBytes -= dropped.bytes
    }
  }

  private dispatch(key: string, message: SseMessage, seq: number): void {
    const bucket = this.listeners.get(key)
    if (!bucket)
      return
    for (const listener of [...bucket]) {
      try {
        listener(message, seq)
      }
      catch {
        bucket.delete(listener)
      }
    }
  }
}

/**
 * Whether a subscriber scoped to `key` receives `message` — the same rule `publish` dispatches by,
 * so a replay cannot deliver a frame the live subscription would have filtered out.
 */
function matches(key: string | null, message: SseMessage): boolean {
  if (key === null)
    return true
  if (message.type !== 'server' && message.type !== 'log')
    return false
  return message.workspaceId !== undefined && serverKey(message.workspaceId, message.serverId) === key
}
