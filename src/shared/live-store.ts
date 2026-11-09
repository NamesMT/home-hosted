import type { AppState, LogLine, ServerView, SseMessage } from './contracts'
import type { ServerSeries } from './live-series'
import { parseFrame } from './live-frames'
import { createSeries, recordSample } from './live-series'
import { serverKey } from './server-key'

/**
 * The live-data layer both UIs build on, with no framework in it.
 *
 * It owns the panel-wide event stream, the per-server log streams (shared between viewers by a
 * refcount), their line buffers and the sample history. A UI wraps it in its own reactivity: it
 * hands in a state holder and an `observe` for the series, and hears about buffer changes through
 * `onLogs`. Every one of these used to live twice, once per UI, and the copies drifted — a fix
 * landed in one and the other kept the bug.
 */

export type ConnectionState = 'connecting' | 'open' | 'closed'

/** `EventSource.CLOSED`: the browser has given up and will not retry on its own. */
export const EVENT_SOURCE_CLOSED = 2

/** The part of `EventSource` the store uses, so a test can hand in a fake. */
export interface LiveEventSource {
  readonly readyState: number
  onopen: ((event: never) => unknown) | null
  onerror: ((event: never) => unknown) | null
  addEventListener: (type: string, listener: (event: { data: string }) => void) => void
  close: () => void
}

export interface LiveStoreOptions {
  openEventSource: (url: string) => LiveEventSource
  /** The panel-wide stream, e.g. `/api/events?logs=0`. */
  eventsUrl: string
  serverStreamUrl: (workspaceId: string, serverId: string) => string
  /** Where the frame lives; a UI passes one backed by its reactive state. */
  state: { get: () => AppState | null, set: (state: AppState) => void }
  /** Lines kept per server; the disk tail holds the archive. */
  maxLines: number
  /** Points kept per series. */
  seriesCapacity: number
  /**
   * Asked after a stream closed for good (the browser stops retrying on any non-200, and a restarted
   * panel answers 401 because sessions are in memory). Resolve `false` when the person is signed
   * out — the UI routes to its login view — and `true` to reconnect with backoff.
   */
  checkSession: () => Promise<boolean>
  onConnection?: (state: ConnectionState) => void
  /** A buffer changed; `lines(key)` now returns a new array. */
  onLogs?: (key: string) => void
  /** Wraps a new series so the UI's charts track it (Vue's `reactive`); identity by default. */
  observe?: <T extends object>(value: T) => T
  now?: () => number
}

/** The reconnect delay: 1 s doubling to 30 s, back to 1 s once a stream opens. */
export function createBackoff(initialMs = 1000, maxMs = 30_000): { next: () => number, reset: () => void } {
  let delay = initialMs
  return {
    next() {
      const current = delay
      delay = Math.min(delay * 2, maxMs)
      return current
    },
    reset() {
      delay = initialMs
    },
  }
}

interface StreamHandlers {
  onOpen: () => void
  onFrame: (frame: SseMessage) => void
  onError?: () => void
  /** The session check said signed out: the stream stays down until opened again. */
  onGiveUp: () => void
}

interface StreamHandle {
  close: () => void
}

interface LogBuffer {
  lines: LogLine[]
  version: number
  refs: number
  stream: StreamHandle | null
}

const FRAME_EVENTS = ['hello', 'state', 'server', 'log'] as const

export function createLiveStore(options: LiveStoreOptions) {
  const observe = options.observe ?? (<T extends object>(value: T): T => value)
  const now = options.now ?? Date.now
  const buffers = new Map<string, LogBuffer>()
  const series = new Map<string, ServerSeries>()
  let global: StreamHandle | null = null
  let warned = false

  /** One stream that reconnects itself after the browser gives up on it. */
  function openStream(url: string, handlers: StreamHandlers): StreamHandle {
    const backoff = createBackoff()
    let source: LiveEventSource | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let closed = false

    async function recover(): Promise<void> {
      const proceed = await options.checkSession().catch(() => true)
      if (closed)
        return
      if (!proceed) {
        closed = true
        handlers.onGiveUp()
        return
      }
      timer = setTimeout(() => {
        timer = null
        if (!closed)
          open()
      }, backoff.next())
    }

    function open(): void {
      const current = options.openEventSource(url)
      source = current
      current.onopen = () => {
        if (source !== current)
          return
        backoff.reset()
        handlers.onOpen()
      }
      current.onerror = () => {
        if (source !== current)
          return
        handlers.onError?.()
        // Anything short of CLOSED is the browser's own retry, which it keeps doing.
        if (current.readyState !== EVENT_SOURCE_CLOSED)
          return
        current.close()
        source = null
        void recover()
      }
      for (const event of FRAME_EVENTS) {
        current.addEventListener(event, (message) => {
          if (source !== current)
            return
          const parsed = parseFrame(message.data)
          if (parsed === null) {
            console.warn('[home-hosted] ignored malformed SSE frame')
            return
          }
          if (parsed.lenient && !warned) {
            warned = true
            console.warn('[home-hosted] the panel sent values this UI does not know; showing them as-is')
          }
          handlers.onFrame(parsed.frame)
        })
      }
    }

    open()
    return {
      close() {
        closed = true
        source?.close()
        source = null
        if (timer !== null)
          clearTimeout(timer)
        timer = null
      },
    }
  }

  function seriesFor(key: string): ServerSeries {
    const existing = series.get(key)
    if (existing)
      return existing
    const created = observe(createSeries())
    series.set(key, created)
    return created
  }

  function sample(server: ServerView, workspaceId: string): void {
    recordSample(seriesFor(serverKey(workspaceId, server.id)), server, now(), options.seriesCapacity)
  }

  function applyState(state: AppState): void {
    options.state.set(state)
    for (const workspace of state.workspaces) {
      for (const server of workspace.servers)
        sample(server as ServerView, workspace.id)
    }
  }

  /**
   * Replaces one entry in the frame. A `server` frame may omit `workspaceId` (an older panel), so an
   * id that exists in exactly one workspace is unambiguous; anything else is dropped, not guessed at.
   */
  function upsertServer(server: ServerView): void {
    const current = options.state.get()
    if (!current)
      return
    const explicit = server.workspaceId
    const owners = explicit === undefined
      ? current.workspaces.filter(workspace => workspace.servers.some(entry => entry.id === server.id))
      : current.workspaces.filter(workspace => workspace.id === explicit)
    if (owners.length !== 1)
      return
    const workspace = owners[0]!
    const withWorkspace: ServerView = explicit === undefined ? { ...server, workspaceId: workspace.id } : server
    workspace.servers = workspace.servers.some(entry => entry.id === server.id)
      ? workspace.servers.map(entry => (entry.id === server.id ? withWorkspace : entry))
      : [...workspace.servers, withWorkspace]
    sample(withWorkspace, workspace.id)
  }

  function bufferFor(key: string): LogBuffer {
    const existing = buffers.get(key)
    if (existing)
      return existing
    const created: LogBuffer = { lines: [], version: 0, refs: 0, stream: null }
    buffers.set(key, created)
    return created
  }

  function setLines(key: string, buffer: LogBuffer, lines: LogLine[]): void {
    // A new array per change, never a push: a derived value compared by identity must see it move.
    buffer.lines = lines
    buffer.version += 1
    options.onLogs?.(key)
  }

  function appendLines(key: string, batch: LogLine[]): void {
    const buffer = bufferFor(key)
    const merged = buffer.lines.concat(batch)
    setLines(key, buffer, merged.length > options.maxLines ? merged.slice(merged.length - options.maxLines) : merged)
  }

  function resetLogs(key: string): void {
    setLines(key, bufferFor(key), [])
  }

  function openServerStream(workspaceId: string, serverId: string, buffer: LogBuffer): void {
    const key = serverKey(workspaceId, serverId)
    // Every connect replays the panel's last buffered lines, so whatever a previous connection kept
    // would show twice. Clear when the stream starts and again on every (re)open.
    resetLogs(key)
    buffer.stream = openStream(options.serverStreamUrl(workspaceId, serverId), {
      onOpen: () => resetLogs(key),
      onFrame(frame) {
        if (frame.type === 'log')
          appendLines(key, frame.lines)
        else if (frame.type === 'server')
          upsertServer(frame.server as ServerView)
      },
      onGiveUp() {
        buffer.stream = null
      },
    })
  }

  function handleGlobalFrame(frame: SseMessage): void {
    if (frame.type === 'hello' || frame.type === 'state') {
      applyState(frame.state)
      return
    }
    if (frame.type === 'server') {
      upsertServer(frame.server as ServerView)
      return
    }
    if (frame.type !== 'log')
      return
    // A log frame without a workspace cannot be keyed correctly, so it is dropped.
    if (frame.workspaceId !== undefined)
      appendLines(serverKey(frame.workspaceId, frame.serverId), frame.lines)
  }

  return {
    /** Opens the panel-wide stream; a no-op while one is open or reconnecting. */
    connect(): void {
      if (global)
        return
      options.onConnection?.('connecting')
      global = openStream(options.eventsUrl, {
        onOpen: () => options.onConnection?.('open'),
        onError: () => options.onConnection?.('closed'),
        onFrame: handleGlobalFrame,
        onGiveUp() {
          global = null
        },
      })
    },
    disconnect(): void {
      global?.close()
      global = null
    },
    applyState,
    lines(key: string): LogLine[] {
      return buffers.get(key)?.lines ?? []
    },
    logVersion(key: string): number {
      return buffers.get(key)?.version ?? 0
    },
    resetLogs(key: string): void {
      if (buffers.has(key))
        resetLogs(key)
    },
    /** One more viewer of a server's live output; the first opens the stream. */
    acquireLogs(workspaceId: string, serverId: string): void {
      const buffer = bufferFor(serverKey(workspaceId, serverId))
      buffer.refs += 1
      if (!buffer.stream)
        openServerStream(workspaceId, serverId, buffer)
    },
    /** One viewer fewer; the last closes the stream. */
    releaseLogs(workspaceId: string, serverId: string): void {
      const buffer = buffers.get(serverKey(workspaceId, serverId))
      if (!buffer)
        return
      buffer.refs = Math.max(0, buffer.refs - 1)
      if (buffer.refs === 0) {
        buffer.stream?.close()
        buffer.stream = null
      }
    },
    series: seriesFor,
    /** Drops everything kept for a removed server. */
    forget(workspaceId: string, serverId: string): void {
      const key = serverKey(workspaceId, serverId)
      buffers.get(key)?.stream?.close()
      buffers.delete(key)
      series.delete(key)
    },
  }
}
