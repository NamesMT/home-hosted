import type { AppState, LogLine } from '#src/shared/contracts'
import type { LiveEventSource, LiveStoreOptions } from '#src/shared/live-store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackoff, createLiveStore, EVENT_SOURCE_CLOSED } from '#src/shared/live-store'

/** An EventSource the test drives by hand: open it, push frames, fail it. */
class FakeSource implements LiveEventSource {
  static all: FakeSource[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  private readonly listeners = new Map<string, Array<(event: { data: string }) => void>>()

  constructor(readonly url: string) {
    FakeSource.all.push(this)
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(): void {
    this.closed = true
    this.readyState = EVENT_SOURCE_CLOSED
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  emit(payload: Record<string, unknown> & { type: string }): void {
    for (const listener of this.listeners.get(payload.type) ?? [])
      listener({ data: JSON.stringify({ ts: 1, ...payload }) })
  }

  /** The browser's transient retry (CONNECTING) or its final give-up (CLOSED, e.g. a 401). */
  fail(final: boolean): void {
    this.readyState = final ? EVENT_SOURCE_CLOSED : 0
    this.onerror?.()
  }
}

function server(id: string, extra: Record<string, unknown> = {}) {
  return { id, status: 'running', config: { id }, resources: null, responseMs: null, ...extra }
}

function state(workspaces: Array<{ id: string, servers: unknown[] }>): AppState {
  return { control: {}, host: {}, backups: {}, ui: {}, workspaces } as unknown as AppState
}

function line(text: string): LogLine {
  return { ts: 1, stream: 'stdout', text }
}

const sources = (prefix: string): FakeSource[] => FakeSource.all.filter(source => source.url.startsWith(prefix))
const latest = (prefix: string): FakeSource => sources(prefix).at(-1)!

function harness(overrides: Partial<LiveStoreOptions> = {}) {
  let current: AppState | null = null
  const connection: string[] = []
  const changed: string[] = []
  const checkSession = vi.fn(async () => true)
  const store = createLiveStore({
    openEventSource: url => new FakeSource(url),
    eventsUrl: '/events',
    serverStreamUrl: (workspaceId, serverId) => `/stream/${workspaceId}/${serverId}`,
    state: { get: () => current, set: (next) => { current = next } },
    maxLines: 3,
    seriesCapacity: 5,
    checkSession,
    onConnection: value => connection.push(value),
    onLogs: key => changed.push(key),
    now: () => 10_000,
    ...overrides,
  })
  return { store, connection, changed, checkSession, state: () => current }
}

beforeEach(() => {
  FakeSource.all = []
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the backoff', () => {
  it('doubles from 1 s to a 30 s ceiling and starts over on reset', () => {
    const backoff = createBackoff()
    expect(Array.from({ length: 7 }, () => backoff.next())).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000])
    backoff.reset()
    expect(backoff.next()).toBe(1000)
  })
})

describe('the panel-wide stream', () => {
  it('opens once, reports its connection, and folds state frames in', () => {
    const live = harness()
    live.store.connect()
    live.store.connect()
    expect(sources('/events')).toHaveLength(1)
    latest('/events').open()
    latest('/events').emit({ type: 'state', state: state([{ id: 'a', servers: [server('web')] }]) })
    expect(live.state()?.workspaces[0]?.servers[0]?.id).toBe('web')
    expect(live.connection).toEqual(['connecting', 'open'])
    // A state frame samples every server it carries.
    expect(live.store.series('a/web').ts).toEqual([10_000])
  })

  it('leaves a transient error to the browser\'s own retry', async () => {
    const live = harness()
    live.store.connect()
    latest('/events').fail(false)
    await vi.runAllTimersAsync()
    expect(live.connection.at(-1)).toBe('closed')
    expect(live.checkSession).not.toHaveBeenCalled()
    expect(sources('/events')).toHaveLength(1)
  })

  /**
   * The reported bug: a restarted panel forgets its in-memory sessions, the browser's reconnect gets
   * 401, and an EventSource stops retrying on any non-200 — the live view froze for good.
   */
  it('reconnects with backoff after the browser gives up, and resets the delay once open', async () => {
    const live = harness()
    live.store.connect()
    latest('/events').fail(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(live.checkSession).toHaveBeenCalledTimes(1)
    expect(sources('/events')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(sources('/events')).toHaveLength(2)

    // Still down: the next wait is twice as long.
    latest('/events').fail(true)
    await vi.advanceTimersByTimeAsync(1999)
    expect(sources('/events')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(sources('/events')).toHaveLength(3)

    // Open resets it.
    latest('/events').open()
    latest('/events').fail(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sources('/events')).toHaveLength(4)
  })

  it('stops when the session is gone, and a later connect starts over', async () => {
    const checkSession = vi.fn(async () => false)
    const live = harness({ checkSession })
    live.store.connect()
    latest('/events').fail(true)
    await vi.runAllTimersAsync()
    expect(sources('/events')).toHaveLength(1)

    // Signed in again: the shell connects, and that must not be a no-op.
    live.store.connect()
    expect(sources('/events')).toHaveLength(2)
  })

  it('treats a failing session check as a panel still coming back', async () => {
    const live = harness({ checkSession: async () => Promise.reject(new Error('down')) })
    live.store.connect()
    latest('/events').fail(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sources('/events')).toHaveLength(2)
  })

  it('cancels a pending reconnect on disconnect, and ignores a closed source', async () => {
    const live = harness()
    live.store.connect()
    const first = latest('/events')
    first.fail(true)
    await vi.advanceTimersByTimeAsync(0)
    live.store.disconnect()
    await vi.runAllTimersAsync()
    expect(sources('/events')).toHaveLength(1)

    // Events from a source that is no longer current change nothing.
    first.open()
    first.emit({ type: 'state', state: state([]) })
    expect(live.state()).toBeNull()
  })

  it('keeps its own session check from reopening after a disconnect landed during it', async () => {
    let release: (value: boolean) => void = () => {}
    const live = harness({ checkSession: () => new Promise<boolean>((resolve) => { release = resolve }) })
    live.store.connect()
    latest('/events').fail(true)
    live.store.disconnect()
    release(true)
    await vi.runAllTimersAsync()
    expect(sources('/events')).toHaveLength(1)
  })

  it('upserts a server frame into its workspace, and drops one it cannot place', () => {
    const live = harness()
    live.store.connect()
    const events = latest('/events')
    // Before any state, a server frame has nowhere to go.
    events.emit({ type: 'server', serverId: 'web', server: server('web') })
    expect(live.state()).toBeNull()

    events.emit({ type: 'state', state: state([{ id: 'a', servers: [server('web')] }, { id: 'b', servers: [server('web'), server('db')] }]) })
    events.emit({ type: 'server', serverId: 'web', workspaceId: 'a', server: server('web', { workspaceId: 'a', status: 'stopped' }) })
    expect(live.state()?.workspaces[0]?.servers[0]?.status).toBe('stopped')

    // No workspace and an id in two of them: ambiguous, dropped.
    events.emit({ type: 'server', serverId: 'web', server: server('web', { status: 'crashed' }) })
    expect(live.state()?.workspaces.map(w => w.servers[0]?.status)).toEqual(['stopped', 'running'])

    // No workspace but a unique id: placed, and given its workspace.
    events.emit({ type: 'server', serverId: 'db', server: server('db', { status: 'starting' }) })
    expect(live.state()?.workspaces[1]?.servers[1]).toMatchObject({ status: 'starting', workspaceId: 'b' })

    // A new id in a named workspace is appended.
    events.emit({ type: 'server', serverId: 'api', workspaceId: 'a', server: server('api', { workspaceId: 'a' }) })
    expect(live.state()?.workspaces[0]?.servers.map(entry => entry.id)).toEqual(['web', 'api'])
  })

  it('keys a global log frame by its workspace, drops one without, and ignores garbage', () => {
    const live = harness()
    live.store.connect()
    const events = latest('/events')
    events.emit({ type: 'log', serverId: 'web', workspaceId: 'a', lines: [line('x')] })
    events.emit({ type: 'log', serverId: 'web', lines: [line('y')] })
    events.emit({ type: 'log', serverId: 'web', lines: 'nope' })
    expect(live.store.lines('a/web').map(entry => entry.text)).toEqual(['x'])
    expect(live.changed).toEqual(['a/web'])
  })
})

describe('the per-server log streams', () => {
  it('shares one stream between viewers and closes it with the last', () => {
    const live = harness()
    live.store.acquireLogs('a', 'web')
    live.store.acquireLogs('a', 'web')
    expect(sources('/stream/a/web')).toHaveLength(1)
    live.store.releaseLogs('a', 'web')
    expect(latest('/stream/a/web').closed).toBe(false)
    live.store.releaseLogs('a', 'web')
    expect(latest('/stream/a/web').closed).toBe(true)
    // Releasing what nobody holds is harmless.
    live.store.releaseLogs('a', 'web')
    live.store.releaseLogs('a', 'none')
  })

  it('caps the buffer and hands out a new array per batch', () => {
    const live = harness()
    live.store.acquireLogs('a', 'web')
    const stream = latest('/stream/a/web')
    stream.open()
    const before = live.store.lines('a/web')
    stream.emit({ type: 'log', serverId: 'web', lines: [line('1'), line('2')] })
    stream.emit({ type: 'log', serverId: 'web', lines: [line('3'), line('4')] })
    expect(live.store.lines('a/web')).not.toBe(before)
    expect(live.store.lines('a/web').map(entry => entry.text)).toEqual(['2', '3', '4'])
    expect(live.store.logVersion('a/web')).toBeGreaterThan(2)
  })

  /**
   * Each connect replays the panel's last 200 lines. Clearing only when the stream was created left
   * the browser's own reconnect (and ours) appending the replay to what was already shown.
   */
  it('clears the buffer on every (re)open, so a replay is not shown twice', async () => {
    const live = harness({ maxLines: 100 })
    live.store.acquireLogs('a', 'web')
    const tail = [line('a'), line('b')]
    latest('/stream/a/web').open()
    latest('/stream/a/web').emit({ type: 'log', serverId: 'web', lines: tail })

    // The browser reconnects on its own and fires open again before the replay.
    latest('/stream/a/web').fail(false)
    latest('/stream/a/web').open()
    latest('/stream/a/web').emit({ type: 'log', serverId: 'web', lines: tail })
    expect(live.store.lines('a/web').map(entry => entry.text)).toEqual(['a', 'b'])

    // And after it gave up and the store reconnected.
    latest('/stream/a/web').fail(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sources('/stream/a/web')).toHaveLength(2)
    latest('/stream/a/web').open()
    latest('/stream/a/web').emit({ type: 'log', serverId: 'web', lines: tail })
    expect(live.store.lines('a/web').map(entry => entry.text)).toEqual(['a', 'b'])
  })

  it('reopens on the next acquire after a signed-out give-up', async () => {
    const live = harness({ checkSession: async () => false })
    live.store.acquireLogs('a', 'web')
    latest('/stream/a/web').fail(true)
    await vi.runAllTimersAsync()
    expect(sources('/stream/a/web')).toHaveLength(1)
    live.store.acquireLogs('a', 'web')
    expect(sources('/stream/a/web')).toHaveLength(2)
  })

  it('folds a server frame from the stream into the state', () => {
    const live = harness()
    live.store.applyState(state([{ id: 'a', servers: [server('web')] }]))
    live.store.acquireLogs('a', 'web')
    latest('/stream/a/web').emit({ type: 'server', serverId: 'web', workspaceId: 'a', server: server('web', { workspaceId: 'a', status: 'stopping' }) })
    expect(live.state()?.workspaces[0]?.servers[0]?.status).toBe('stopping')
  })

  it('resets on request, and forgets a removed server entirely', () => {
    const live = harness()
    live.store.applyState(state([{ id: 'a', servers: [server('web')] }]))
    live.store.acquireLogs('a', 'web')
    latest('/stream/a/web').emit({ type: 'log', serverId: 'web', lines: [line('x')] })
    live.store.resetLogs('a/web')
    expect(live.store.lines('a/web')).toEqual([])
    // A key with no buffer stays absent.
    live.store.resetLogs('a/none')
    expect(live.store.logVersion('a/none')).toBe(0)

    const series = live.store.series('a/web')
    live.store.forget('a', 'web')
    expect(latest('/stream/a/web').closed).toBe(true)
    expect(live.store.logVersion('a/web')).toBe(0)
    expect(live.store.series('a/web')).not.toBe(series)
  })

  it('wraps each new series with the UI\'s observer', () => {
    const observed: object[] = []
    const live = harness({
      observe: (value) => {
        observed.push(value)
        return value
      },
    })
    const series = live.store.series('a/web')
    expect(live.store.series('a/web')).toBe(series)
    expect(observed).toEqual([series])
  })

  it('warns once about a lenient frame, and still applies it', () => {
    const live = harness()
    live.store.connect()
    const events = latest('/events')
    events.emit({ type: 'state', state: state([{ id: 'a', servers: [server('web', { status: 'hibernating' })] }]) })
    events.emit({ type: 'state', state: state([{ id: 'a', servers: [server('web', { status: 'hibernating' })] }]) })
    expect(live.state()?.workspaces[0]?.servers[0]?.status).toBe('hibernating')
    const lenientWarnings = vi.mocked(console.warn).mock.calls.filter(call => String(call[0]).includes('does not know'))
    expect(lenientWarnings).toHaveLength(1)
  })
})
