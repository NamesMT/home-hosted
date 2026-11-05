import type { SSEStreamingApi } from 'hono/streaming'
import { describe, expect, it } from 'vitest'
import { frameKey, sseChannel } from '#src/helpers/sse'

/** A stream whose writes stay pending until `release()`, like a client that stopped reading. */
function stalledStream() {
  const written: Array<{ event?: string, data: string }> = []
  let release: () => void = () => {}
  let gate = new Promise<void>(resolve => (release = resolve))
  const stream = {
    writeSSE: async (message: { event?: string, data: string }) => {
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
})
