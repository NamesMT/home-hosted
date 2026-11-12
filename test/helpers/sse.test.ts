import type { SSEStreamingApi } from 'hono/streaming'
import { describe, expect, it } from 'vitest'
import { frameKey, sseChannel } from '#src/helpers/sse'

/** A stream whose writes stay pending until `release()`, like a client that stopped reading. */
function stalledStream() {
  const written: Array<{ event?: string, data: string, id?: string, retry?: number }> = []
  let release: () => void = () => {}
  let gate = new Promise<void>(resolve => (release = resolve))
  const stream = {
    writeSSE: async (message: { event?: string, data: string, id?: string, retry?: number }) => {
      await gate
      written.push(message)
    },
  } as unknown as SSEStreamingApi
  return {
    stream,
    written,
    open: () => {
      release()
      gate = Promise.resolve()
    },
  }
}

describe('sseChannel', () => {
  it('keeps only the newest snapshot per key while a client is not reading', async () => {
    const { stream, written, open } = stalledStream()
    const channel = sseChannel(stream)
    channel.send('hello', 'h')
    for (let i = 0; i < 1000; i++) {
      channel.send('state', `s${i}`, { key: 'state' })
      channel.send('log', `l${i}`, { droppable: true })
    }
    open()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(written[0]).toEqual({ event: 'hello', data: 'h' })
    const states = written.filter(frame => frame.event === 'state')
    expect(states, 'a stalled client must not queue a snapshot per tick').toHaveLength(1)
    expect(states[0]!.data).toBe('s999')
    expect(written.filter(frame => frame.event === 'log').length).toBeLessThanOrEqual(200)
  })

  it('stops writing once closed', async () => {
    const { stream, written, open } = stalledStream()
    const channel = sseChannel(stream)
    channel.close()
    channel.send('state', 's', { key: 'state' })
    open()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(written).toHaveLength(0)
  })

  it('keys snapshots by what they describe, and never a log', () => {
    expect(frameKey({ type: 'state' })).toBe('state')
    expect(frameKey({ type: 'server', workspaceId: 'a', serverId: 'web' })).not.toBe(frameKey({ type: 'server', workspaceId: 'b', serverId: 'web' }))
    expect(frameKey({ type: 'log', serverId: 'web' })).toBeUndefined()
  })

  /**
   * A coalesced frame carries the **newer** id.
   *
   * A queued `state` frame is replaced by the next tick's, and that replacement must take the newer
   * sequence with it. Leaving the superseded id on the queue — which is what a merge that copied only
   * `event`/`data` did — means the client's `Last-Event-ID` ends up behind the frame it was actually
   * sent, and a resume replays frames it already has.
   */
  it('takes the newer id when a frame supersedes a queued one', async () => {
    const { stream, written, open } = stalledStream()
    const channel = sseChannel(stream)
    // Occupy the pump with a first frame: coalescing applies to what is still *queued*, and this one
    // is already in flight.
    channel.send('hello', 'h', { key: 'hello', id: 1 })
    channel.send('state', 's2', { key: 'state', id: 2 })
    channel.send('state', 's3', { key: 'state', id: 3 })
    open()
    await new Promise(resolve => setTimeout(resolve, 20))

    // The in-flight frame, then the surviving snapshot — `s2` was superseded, never written.
    expect(written).toHaveLength(2)
    expect(written[1]).toMatchObject({ event: 'state', data: 's3', id: '3' })
  })

  /** `id:` and `retry:` reach the wire as SSE control lines, and an absent one is not sent as `undefined`. */
  it('writes id and retry through to the SSE control lines', async () => {
    const { stream, written, open } = stalledStream()
    const channel = sseChannel(stream)
    channel.send('hello', 'h', { key: 'hello', id: 7, retry: 3000 })
    channel.send('log', 'l', { droppable: true })
    open()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(written[0]).toMatchObject({ event: 'hello', data: 'h', id: '7', retry: 3000 })
    // A frame with neither must not carry the keys at all: Hono emits `id: undefined` as the string.
    expect(written[1]).not.toHaveProperty('id')
    expect(written[1]).not.toHaveProperty('retry')
  })
})
