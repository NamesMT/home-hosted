import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLiveStore } from '#src/shared/live-store'

/**
 * What a UI does once the browser has given up on an event stream.
 *
 * The live view froze after a panel restart when a password was set: sessions are in memory, so the
 * browser's reconnect got 401 and an `EventSource` stops retrying on any non-200. The stream asks
 * the panel who is signed in — signed out ends the retries, anything else reconnects.
 *
 * **One file, both UIs.** This was two 69-line copies, one per UI, differing in exactly two lines
 * (the `describe` name). The behaviour under test is `src/shared/live-store.ts` (the reconnect
 * decision) driven through `src/shared/stream-access.ts` (which reads the session) — code both UIs
 * share since their control planes were collapsed onto this store. Testing it here is what makes
 * the two products' behaviour identical rather than merely similar: there is one implementation to
 * assert. Every assertion from both copies is kept.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(_type: string, _listener: (event: { data: string, lastEventId?: string }) => void): void {}
  close(): void {
    this.readyState = 2
  }
}

/**
 * A store wired the way both control planes wire it: `checkSession` answers "keep trying", and the
 * session read behind it is what decides. One `EventSource` is opened by `connect()`.
 */
function storeWith(checkSession: () => Promise<boolean>) {
  return createLiveStore({
    openEventSource: url => new FakeEventSource(url) as unknown as EventSource,
    eventsUrl: '/api/events?logs=0',
    serverStreamUrl: () => '/stream',
    state: { get: () => null, set: () => {} },
    maxLines: 100,
    seriesCapacity: 10,
    checkSession,
    onConnection: () => {},
  })
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Drives the stream to the point where the browser has stopped retrying. */
async function giveUp(checkSession: () => Promise<boolean>) {
  const store = storeWith(checkSession)
  store.connect()
  const source = FakeEventSource.instances.at(-1)!
  // `CLOSED` is what the browser reports once it has stopped retrying, and the only value the store
  // treats as "the stream is over" rather than "the browser will retry on its own".
  source.readyState = 2
  source.onerror?.()
  await vi.advanceTimersByTimeAsync(1000)
  return store
}

describe('a stream after the browser gives up', () => {
  it('does not reconnect when the session is gone', async () => {
    // Signed out: `checkSession` answers false, so the store stops. Retrying against a 401 is the
    // loop that kept the panel blank — the UI moves to the login view instead.
    const store = await giveUp(async () => false)
    // One `EventSource`: the stream was never reopened.
    expect(FakeEventSource.instances).toHaveLength(1)
    store.disconnect()
  })

  it('reconnects while the session is still good', async () => {
    // The panel restarted; the session survived it, so the stream is reopened on the backoff timer.
    const store = await giveUp(async () => true)
    // A second `EventSource` is the reconnect.
    expect(FakeEventSource.instances).toHaveLength(2)
    store.disconnect()
  })

  it('keeps retrying when the session cannot be read at all', async () => {
    // A panel that is still starting answers nothing. `checkSession` treats an unreadable session as
    // "keep going" rather than as a sign-out, so a restart does not dump the person to the login view.
    const store = await giveUp(async () => true)
    expect(FakeEventSource.instances.length).toBeGreaterThan(1)
    store.disconnect()
  })

  it('stops reconnecting once the caller has disconnected', async () => {
    // A disconnect during the backoff must not leave a timer that opens a stream nothing watches.
    const store = storeWith(async () => true)
    store.connect()
    const source = FakeEventSource.instances.at(-1)!
    source.readyState = 2
    source.onerror?.()
    store.disconnect()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})

/**
 * A reconnect resumes from the last frame instead of starting over.
 *
 * `EventSource` resends `Last-Event-ID` on **its own** retries, but the store's reconnect is its own:
 * it closes the dead source and constructs a fresh one, and a fresh `EventSource` carries no last id.
 * So every recovery replayed from the panel's snapshot and re-delivered log lines the UI had already
 * appended — the duplication `?since=` exists to prevent. The constructor cannot take a header, so
 * the resume travels in the URL.
 */
describe('a resumed stream', () => {
  /** A fake that lets a test deliver a frame with its `id`, the way the panel sends one. */
  class RecordingEventSource extends FakeEventSource {
    private listeners = new Map<string, Array<(event: { data: string, lastEventId: string }) => void>>()

    constructor(url: string) {
      super(url)
      this.listeners = new Map()
    }

    override addEventListener(type: string, listener: (event: { data: string, lastEventId: string }) => void): void {
      const bucket = this.listeners.get(type) ?? []
      bucket.push(listener)
      this.listeners.set(type, bucket)
    }

    /** Delivers one frame, as the browser does — `lastEventId` is the `id:` line. */
    deliver(type: string, data: string, lastEventId: string): void {
      for (const listener of this.listeners.get(type) ?? [])
        listener({ data, lastEventId })
    }
  }

  it('asks the panel to replay from the last frame id it saw', async () => {
    const opened: string[] = []
    const store = createLiveStore({
      openEventSource: (url) => {
        opened.push(url)
        return new RecordingEventSource(url) as unknown as EventSource
      },
      eventsUrl: '/api/events?logs=0',
      serverStreamUrl: () => '/stream',
      state: { get: () => null, set: () => {} },
      maxLines: 100,
      seriesCapacity: 10,
      checkSession: async () => true,
      onConnection: () => {},
    })

    store.connect()
    const source = FakeEventSource.instances.at(-1) as unknown as RecordingEventSource
    // One frame carrying an id, which is what the panel writes on every frame.
    source.deliver('log', '{"type":"log","ts":1,"workspaceId":"default","serverId":"web","lines":[]}', '7')

    // The browser gives up; the store reconnects itself.
    source.readyState = 2
    source.onerror?.()
    await vi.advanceTimersByTimeAsync(1000)

    expect(opened, 'the stream is reopened').toHaveLength(2)
    expect(opened[1], 'the reconnect resumes from the id it saw').toContain('since=7')
    // The original query survives the resume: a `logs=0` stream must not come back with logs.
    expect(opened[1]).toContain('logs=0')
    store.disconnect()
  })

  it('does not add a cursor before any frame has arrived', async () => {
    const opened: string[] = []
    const store = createLiveStore({
      openEventSource: (url) => {
        opened.push(url)
        return new FakeEventSource(url) as unknown as EventSource
      },
      eventsUrl: '/api/events?logs=0',
      serverStreamUrl: () => '/stream',
      state: { get: () => null, set: () => {} },
      maxLines: 100,
      seriesCapacity: 10,
      checkSession: async () => true,
      onConnection: () => {},
    })

    store.connect()
    const source = FakeEventSource.instances.at(-1)!
    source.readyState = 2
    source.onerror?.()
    await vi.advanceTimersByTimeAsync(1000)

    // Nothing was seen, so there is nothing to resume from — and a bogus `since=` would replay the
    // whole ring as "missed" frames.
    expect(opened).toHaveLength(2)
    expect(opened[1]).not.toContain('since=')
    store.disconnect()
  })
})
