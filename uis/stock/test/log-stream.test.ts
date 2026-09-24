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
    scope.run(() => useServerLogs(id))

    expect(FakeEventSource.instances).toHaveLength(0)

    id.value = 'demo'
    await nextTick()
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(latest().url).toBe('/api/servers/demo/stream')

    id.value = null
    await nextTick()
    expect(latest().closed).toBe(true)

    scope.stop()
  })

  it('invalidates on the first batch, so a cached view shows it without a remount', async () => {
    const id = ref<string | null>(null)
    const scope = effectScope()
    const logs = scope.run(() => useServerLogs(id))!

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

  it('bumps the same signal when the buffer is cleared', async () => {
    const scope = effectScope()
    const logs = scope.run(() => useServerLogs(() => 'beta'))!
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
})

/** The buffers are keyed per server, so a snapshot is just the texts in order. */
function texts(lines: LogLine[]): string[] {
  return lines.map(entry => entry.text)
}
