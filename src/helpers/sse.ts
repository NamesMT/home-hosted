import type { SSEStreamingApi } from 'hono/streaming'

/** Log frames queued past this are dropped; a client that falls behind loses output, not state. */
const MAX_QUEUED_LOGS = 200

interface Frame {
  event: string
  data: string
  /** Frames sharing a key supersede each other; `null` is a frame that never coalesces. */
  key: string | null
}

/**
 * One subscriber's outbound queue, bounded whatever the client does.
 *
 * A client that stops reading without disconnecting must not grow the panel's memory: a queued
 * `state` or `server` frame is replaced by the newer one (only the latest snapshot matters), and log
 * frames are dropped once too many are waiting.
 */
export function sseChannel(stream: SSEStreamingApi) {
  const queue: Frame[] = []
  const state = { closed: false }
  let writing = false

  const pump = async (): Promise<void> => {
    if (writing)
      return
    writing = true
    try {
      while (!state.closed && queue.length > 0) {
        const frame = queue.shift()!
        await stream.writeSSE({ event: frame.event, data: frame.data })
      }
    }
    catch {
      state.closed = true
      queue.length = 0
    }
    finally {
      writing = false
    }
  }

  return {
    get closed(): boolean {
      return state.closed
    },
    close(): void {
      state.closed = true
      queue.length = 0
    },
    /** Queue a frame: `key` makes it supersede a queued frame with the same key; `droppable` caps it. */
    send(event: string, data: string, options: { key?: string, droppable?: boolean } = {}): void {
      if (state.closed)
        return
      const key = options.key ?? null
      if (key !== null) {
        const index = queue.findIndex(frame => frame.key === key)
        if (index !== -1) {
          queue[index] = { event, data, key }
          return
        }
      }
      else if (options.droppable === true && queue.filter(frame => frame.event === event).length >= MAX_QUEUED_LOGS) {
        return
      }
      queue.push({ event, data, key })
      void pump()
    },
  }
}

/** The coalescing key for a hub message: snapshots supersede, logs and one-offs do not. */
export function frameKey(message: { type: string, workspaceId?: string, serverId?: string }): string | undefined {
  if (message.type === 'state')
    return 'state'
  if (message.type === 'server')
    return `server:${message.workspaceId ?? ''}/${message.serverId ?? ''}`
  return undefined
}
