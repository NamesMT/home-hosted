import type { SseMessage } from '#src/shared/contracts'
import { serverKey } from '#src/shared/server-key'

export type EventListener = (message: SseMessage) => void

const ALL = '*'

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

  publish(message: SseMessage): void {
    this.dispatch(ALL, message)
    if (message.serverId && message.workspaceId)
      this.dispatch(serverKey(message.workspaceId, message.serverId), message)
  }

  get subscriberCount(): number {
    let total = 0
    for (const bucket of this.listeners.values()) total += bucket.size
    return total
  }

  private dispatch(key: string, message: SseMessage): void {
    const bucket = this.listeners.get(key)
    if (!bucket)
      return
    for (const listener of [...bucket]) {
      try {
        listener(message)
      }
      catch {
        bucket.delete(listener)
      }
    }
  }
}
