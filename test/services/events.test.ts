import type { AppState } from '#src/shared/contracts'
import { describe, expect, it, vi } from 'vitest'
import { EventHub } from '#src/services/events'

/**
 * The SSE fan-out every log line and state frame goes through.
 *
 * No test named this module: it was exercised only through the API and supervisor suites, which is how
 * the two behaviours below — the workspace scoping and the throwing-listener cleanup — went unpinned.
 */
function logMessage(workspaceId: string, serverId: string): Parameters<EventHub['publish']>[0] {
  return { type: 'log', ts: 1, workspaceId, serverId, lines: [{ ts: 1, stream: 'stdout', text: 'x' }] }
}

describe('event hub', () => {
  it('delivers a server-scoped message only to that workspace’s subscriber', () => {
    const hub = new EventHub()
    const alpha = vi.fn()
    const beta = vi.fn()
    hub.subscribe('alpha/web', alpha)
    hub.subscribe('beta/web', beta)

    hub.publish(logMessage('alpha', 'web'))

    expect(alpha, 'the addressed subscriber').toHaveBeenCalledTimes(1)
    // The whole reason the key is `workspaceId/serverId`: server ids are only unique inside a
    // workspace, so a bare-id key would deliver one workspace's lines to the other.
    expect(beta, 'the same-named server in another workspace').not.toHaveBeenCalled()
  })

  it('delivers to every unscoped subscriber as well', () => {
    const hub = new EventHub()
    const all = vi.fn()
    hub.subscribe(null, all)
    hub.publish(logMessage('alpha', 'web'))
    hub.publish({ type: 'state', ts: 1, state: {} as AppState })
    expect(all).toHaveBeenCalledTimes(2)
  })

  it('drops a listener that throws, and keeps the others', () => {
    const hub = new EventHub()
    const bad = vi.fn(() => { throw new Error('this subscriber is broken') })
    const good = vi.fn()
    hub.subscribe(null, bad)
    hub.subscribe(null, good)

    expect(() => hub.publish({ type: 'state', ts: 1, state: {} as AppState })).not.toThrow()
    expect(good, 'one broken subscriber must not stop the rest').toHaveBeenCalledTimes(1)

    // Removed, so it is not retried on the next frame — and the good one still receives.
    hub.publish({ type: 'state', ts: 2, state: {} as AppState })
    expect(bad, 'a throwing listener is dropped, not retried').toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(2)
  })

  it('stops delivering after unsubscribe, and tolerates unsubscribing twice', () => {
    const hub = new EventHub()
    const listener = vi.fn()
    const off = hub.subscribe('alpha/web', listener)
    hub.publish(logMessage('alpha', 'web'))
    expect(listener).toHaveBeenCalledTimes(1)

    off()
    off()
    hub.publish(logMessage('alpha', 'web'))
    expect(listener, 'unsubscribed').toHaveBeenCalledTimes(1)
  })

  it('unsubscribes a listener from inside its own callback without skipping the next one', () => {
    // `dispatch` iterates a copy for this: removing from the live Set mid-iteration is the case the
    // copy exists for, so it is asserted rather than assumed.
    const hub = new EventHub()
    const second = vi.fn()
    let off: () => void = () => {}
    const first = vi.fn(() => { off() })
    off = hub.subscribe(null, first)
    hub.subscribe(null, second)

    hub.publish({ type: 'state', ts: 1, state: {} as AppState })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second, 'self-unsubscribe must not skip the following listener').toHaveBeenCalledTimes(1)
  })
})

/**
 * The resume buffer: a bounded ring of the replayed frames, and the sequence that addresses it.
 *
 * A stream that reconnects sends the last id it saw, and the panel answers from here — so the two
 * things that can go wrong are a buffer that grows without bound and a replay that hands back a
 * snapshot (which would regress state the client already has).
 */
describe('event hub resume buffer', () => {
  function logFrame(workspaceId: string, serverId: string, text: string) {
    return { type: 'log' as const, ts: 1, workspaceId, serverId, lines: [{ ts: 1, stream: 'stdout' as const, text }] }
  }

  it('numbers every published frame monotonically from one counter', () => {
    const hub = new EventHub()
    const seen: number[] = []
    hub.subscribe(null, (_message, seq) => seen.push(seq))
    for (let index = 0; index < 5; index++)
      hub.publish(logFrame('alpha', 'web', `line-${index}`))

    expect(seen).toEqual([1, 2, 3, 4, 5])
    expect(hub.lastSeq).toBe(5)
  })

  it('replays only the log frames published after the given sequence', () => {
    const hub = new EventHub()
    hub.publish(logFrame('alpha', 'web', 'a'))
    hub.publish(logFrame('alpha', 'web', 'b'))
    const resumed: string[] = []
    hub.subscribeFrom(null, 1, (message) => {
      if (message.type === 'log')
        resumed.push(message.lines[0]!.text)
    })

    // Sequence 1 was the client's last id, so only the later ones replay.
    expect(resumed).toEqual(['b'])
    // …and the subscription is live afterwards.
    hub.publish(logFrame('alpha', 'web', 'c'))
    expect(resumed).toEqual(['b', 'c'])
  })

  /**
   * A snapshot is never replayed.
   *
   * `state` and `server` frames are current-state snapshots; a resumed stream sends one *current* one
   * first. Replaying an older snapshot after it would roll the client's state backwards, which is
   * exactly the failure a snapshot-then-replay ordering exists to prevent.
   */
  it('never buffers a snapshot, only log frames', () => {
    const hub = new EventHub()
    hub.publish({ type: 'state', ts: 1, state: {} as AppState })
    hub.publish({ type: 'server', ts: 1, workspaceId: 'alpha', serverId: 'web', server: {} as never })
    hub.publish(logFrame('alpha', 'web', 'only-me'))

    expect(hub.bufferedFrames).toBe(1)
    const resumed: string[] = []
    hub.subscribeFrom(null, 0, message => resumed.push(message.type))
    expect(resumed).toEqual(['log'])
  })

  it('keeps the buffer bounded by frame count, dropping the oldest', () => {
    const hub = new EventHub()
    for (let index = 0; index < 300; index++)
      hub.publish(logFrame('alpha', 'web', `line-${index}`))

    expect(hub.bufferedFrames).toBeLessThanOrEqual(200)
    // The oldest is gone, the newest kept, and `bufferedFrom` names the first replayable one.
    const replayed: string[] = []
    hub.subscribeFrom(null, -1, (message) => {
      if (message.type === 'log')
        replayed.push(message.lines[0]!.text)
    })
    expect(replayed).toHaveLength(hub.bufferedFrames)
    expect(replayed.at(-1)).toBe('line-299')
    expect(replayed[0]).toBe(`line-${299 - hub.bufferedFrames + 1}`)
    expect(hub.bufferedFrom).toBe(300 - hub.bufferedFrames + 1)
  })

  it('keeps the buffer bounded by bytes, not only by frame count', () => {
    const hub = new EventHub()
    // 200 frames of 8 KB text is far past the 256 KB ceiling.
    for (let index = 0; index < 200; index++)
      hub.publish(logFrame('alpha', 'web', 'x'.repeat(8192)))

    expect(hub.bufferedFrames, 'a byte ceiling must bind before the frame ceiling').toBeLessThan(200)
  })

  /** A scoped subscriber replays only its own server's frames — the same rule `publish` dispatches by. */
  it('replays a scoped subscriber only its own server’s frames', () => {
    const hub = new EventHub()
    hub.publish(logFrame('alpha', 'web', 'mine'))
    hub.publish(logFrame('beta', 'web', 'someone else'))
    hub.publish(logFrame('alpha', 'api', 'also not mine'))

    const replayed: string[] = []
    hub.subscribeFrom('alpha/web', 0, (message) => {
      if (message.type === 'log')
        replayed.push(message.lines[0]!.text)
    })
    expect(replayed).toEqual(['mine'])
  })
})
