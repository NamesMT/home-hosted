import type { LogLine } from '@shared/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, ref } from 'vue'
import { useServerLogs } from '../src/composables/useControlPlane'

/**
 * The reported bug: the Live output view stayed empty until you switched tabs.
 * The composable's log buffers are plain arrays mutated in place, so a view that
 * caches its lines needs a revision signal that fires on the *first* batch — and
 * on every one after it, including when the buffer did not exist yet.
 */

interface Listener {
  (event: { data: string }): void
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  onerror: (() => void) | null = null
  closed = false
  private readonly listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
  }

  close(): void {
    this.closed = true
  }

  /** Push one frame exactly as the server writes it. */
  emit(type: string, payload: unknown): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ data: JSON.stringify(payload) })
  }
}

function line(text: string, ts = 1): LogLine {
  return { ts, stream: 'stdout', text }
}

function logFrame(lines: LogLine[], serverId = 'demo') {
  return { type: 'log', ts: Date.now(), serverId, lines }
}

function latest(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1)
  if (!source)
    throw new Error('no stream was opened')
  return source
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useServerLogs', () => {
  it('opens a stream once the server id is known, and closes it when it goes away', async () => {
    const id = ref<string | null>(null)
    const scope = effectScope()
    scope.run(() => useServerLogs(() => 'default', id))

    expect(FakeEventSource.instances).toHaveLength(0)

    id.value = 'demo'
    await nextTick()
    expect(FakeEventSource.instances).toHaveLength(1)
    // The stream is workspace-scoped now: the same server id can exist twice.
    expect(latest().url).toBe('/api/servers/demo/stream?workspace=default')

    id.value = null
    await nextTick()
    expect(latest().closed).toBe(true)

    scope.stop()
  })

  it('opens nothing until a workspace is selected too', async () => {
    const workspace = ref<string | null>(null)
    const scope = effectScope()
    scope.run(() => useServerLogs(workspace, () => 'demo'))

    // A server id alone is not enough: without a workspace there is no stream to open.
    expect(FakeEventSource.instances).toHaveLength(0)

    workspace.value = 'work'
    await nextTick()
    expect(latest().url).toBe('/api/servers/demo/stream?workspace=work')

    scope.stop()
  })

  it('invalidates on the first batch, so a cached view shows it without a remount', async () => {
    const id = ref<string | null>(null)
    const scope = effectScope()
    const logs = scope.run(() => useServerLogs(() => 'default', id))!

    // A view that evaluated its lines while the panel was still loading state.
    const liveLines = computed(() => {
      void logs.version.value
      return logs.lines()
    })
    expect(liveLines.value).toEqual([])

    // The state frame arrives, the stream opens, and the server replays its tail.
    id.value = 'alpha'
    await nextTick()
    latest().emit('log', logFrame([line('first'), line('second')], 'alpha'))

    expect(texts(liveLines.value)).toEqual(['first', 'second'])
    expect(logs.count.value).toBe(2)

    // A second batch must keep invalidating the same cached view.
    latest().emit('log', logFrame([line('third', 2)], 'alpha'))
    expect(texts(liveLines.value)).toEqual(['first', 'second', 'third'])

    scope.stop()
  })

  it('hands out a new array per batch, so a derived count cannot go stale', async () => {
    // The real bug, second half: Vue does not notify a computed's subscribers when
    // its recomputed value is Object.is-equal to the previous one. A buffer that
    // pushed into its array in place therefore left the viewer's line count frozen
    // at the value it read first, however many lines arrived. A new identity per
    // batch is what makes derived values (count, matches, window) update, and the
    // version is what makes the views re-read at all.
    const scope = effectScope()
    const logs = scope.run(() => useServerLogs(() => 'default', () => 'gamma'))!
    await nextTick()

    const first = logs.lines()
    latest().emit('log', logFrame([line('a'), line('b')], 'gamma'))

    expect(logs.lines()).not.toBe(first)
    expect(texts(logs.lines())).toEqual(['a', 'b'])

    // The shape a viewer uses: a count derived from the array, invalidated by version.
    const total = computed(() => {
      void logs.version.value
      return logs.lines().length
    })
    expect(total.value).toBe(2)

    const second = logs.lines()
    latest().emit('log', logFrame([line('c', 3)], 'gamma'))
    expect(logs.lines()).not.toBe(second)
    expect(total.value).toBe(3)

    scope.stop()
  })

  it('bumps the same signal when the buffer is cleared', async () => {
    const scope = effectScope()
    const logs = scope.run(() => useServerLogs(() => 'default', () => 'beta'))!
    await nextTick()

    latest().emit('log', logFrame([line('something')], 'beta'))
    expect(logs.lines()).toHaveLength(1)

    const before = logs.version.value
    logs.clear()
    expect(logs.version.value).toBeGreaterThan(before)
    expect(logs.lines()).toEqual([])
    expect(logs.count.value).toBe(0)

    scope.stop()
  })

  /**
   * The panel replays its last 200 buffered lines on every connect, so a buffer kept
   * across connections showed that tail twice — LogsView drops the id when you switch to
   * Persisted and re-acquires it on the way back, and ServerDetailView does the same on a
   * remount. Starting a stream is the moment to forget the previous one's lines.
   */
  it('does not replay a previous connection\'s tail into a fresh stream', async () => {
    const scope = effectScope()
    const id = ref<string | null>('beta')
    const logs = scope.run(() => useServerLogs(() => 'default', id))!
    await nextTick()

    const tail = [line('a'), line('b')]
    latest().emit('log', logFrame(tail, 'beta'))
    expect(texts(logs.lines())).toEqual(['a', 'b'])

    // Leave the live view and come back: a new source, and the panel replays its tail.
    id.value = null
    await nextTick()
    id.value = 'beta'
    await nextTick()

    const second = latest()
    expect(second).not.toBe(FakeEventSource.instances[0])
    second.emit('log', logFrame(tail, 'beta'))

    // The replay replaced the buffer, so the tail appears once.
    expect(texts(logs.lines())).toEqual(['a', 'b'])
    expect(logs.count.value).toBe(2)

    scope.stop()
  })
})

/** The buffers are keyed per server, so a snapshot is just the texts in order. */
function texts(lines: LogLine[]): string[] {
  return lines.map(entry => entry.text)
}
