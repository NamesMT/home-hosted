import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForEndpoint } from '#src/shared/endpoint'

/**
 * Waiting for a rebind, not sleeping through it.
 *
 * The listener can move to another host and port, and the browser follows to a socket that is not
 * accepting yet. This polls `/api/auth/session` — a route that needs no session — so it returns as soon
 * as the panel answers rather than after a fixed delay. It was byte-identical in both UIs.
 */
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('waitForEndpoint', () => {
  it('returns as soon as the endpoint answers, without waiting out the timeout', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const started = Date.now()
    await expect(waitForEndpoint('http://127.0.0.1:3999', 5_000)).resolves.toBe(true)
    // One call, not a poll loop: it succeeded on the first probe.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(Date.now() - started, 'it must not sleep after a success').toBeLessThan(1_000)
  })

  it('asks a route that needs no session, so it works before signing in', async () => {
    // Typed explicitly: `vi.fn` infers an empty parameter tuple from the arrow, so indexing the
    // recorded calls does not typecheck.
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await waitForEndpoint('http://127.0.0.1:3999')
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('http://127.0.0.1:3999/api/auth/session')
    // `no-store`: a cached 200 from before the move would make this return immediately and wrongly.
    expect(init?.cache).toBe('no-store')
  })

  it('gives up after the timeout when the endpoint never answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const started = Date.now()
    await expect(waitForEndpoint('http://127.0.0.1:3999', 300)).resolves.toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    // A deadline the loop ignores would hang until vitest's own timeout; failing here instead keeps
    // the signal local and the run fast.
  }, 5_000)
})
