import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { resetLogs, unwatchLogs, watchLogs } from '../src/composables/useControlPlane'

/**
 * Each per-server stream replays the panel's last 200 lines on connect, and `watchLogs` never cleared:
 * every browser reconnect appended the same tail again. The pane's array is now emptied on every open.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  private readonly listeners = new Map<string, Array<(event: { data: string }) => void>>()
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(): void {
    this.readyState = 2
  }

  emitLines(texts: string[]): void {
    const frame = { type: 'log', ts: 1, workspaceId: 'w', serverId: 'web', lines: texts.map(text => ({ ts: 1, stream: 'stdout', text })) }
    for (const listener of this.listeners.get('log') ?? [])
      listener({ data: JSON.stringify(frame) })
  }
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('noc-console live log buffers', () => {
  it('shows a replayed tail once after the stream reconnects', async () => {
    const lines = watchLogs('w', 'web')
    const source = FakeEventSource.instances.at(-1)!
    source.onopen?.()
    source.emitLines(['a', 'b'])
    expect(lines.map(line => line.text)).toEqual(['a', 'b'])

    // The browser's own reconnect: an error, then open, then the same replay.
    source.onerror?.()
    source.onopen?.()
    source.emitLines(['a', 'b'])
    await nextTick()
    // The same array the pane holds, cleared and refilled.
    expect(lines.map(line => line.text)).toEqual(['a', 'b'])

    resetLogs('w', 'web')
    expect(lines).toEqual([])
    unwatchLogs('w', 'web')
    expect(source.readyState).toBe(2)
  })
})
