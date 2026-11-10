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

  addEventListener(): void {}
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
