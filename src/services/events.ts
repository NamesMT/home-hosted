import type { SseMessage } from '#src/shared/contracts'

export type EventListener = (message: SseMessage) => void

const ALL = '*'

/** Fan-out for SSE subscribers, optionally scoped to a single server. */
export class EventHub {
  private readonly listeners = new Map<string, Set<EventListener>>()

  subscribe(serverId: string | null, listener: EventListener): () => void {
    const key = serverId ?? ALL
    const bucket = this.listeners.get(key) ?? new Set<EventListener>()
    bucket.add(listener)
    this.listeners.set(key, bucket)

    return () => {
      bucket.delete(listener)
      if (bucket.size === 0)
        this.listeners.delete(key)
    }
  }

  publish(message: SseMessage): void {
    this.dispatch(ALL, message)
    if (message.serverId)
      this.dispatch(message.serverId, message)
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
