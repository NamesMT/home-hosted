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
    hub.publish({ type: 'state', ts: 1 })
    expect(all).toHaveBeenCalledTimes(2)
  })

  it('drops a listener that throws, and keeps the others', () => {
    const hub = new EventHub()
    const bad = vi.fn(() => { throw new Error('this subscriber is broken') })
    const good = vi.fn()
    hub.subscribe(null, bad)
    hub.subscribe(null, good)

    expect(() => hub.publish({ type: 'state', ts: 1 })).not.toThrow()
    expect(good, 'one broken subscriber must not stop the rest').toHaveBeenCalledTimes(1)

    // Removed, so it is not retried on the next frame — and the good one still receives.
    hub.publish({ type: 'state', ts: 2 })
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

    hub.publish({ type: 'state', ts: 1 })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second, 'self-unsubscribe must not skip the following listener').toHaveBeenCalledTimes(1)
  })
})
