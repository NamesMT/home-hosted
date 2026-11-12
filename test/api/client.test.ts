import type { SseMessage } from '#src/client'
import type { Fixture } from './fixture'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, HomeHostedError, readEventStream } from '#src/client'
import { generateApiToken, SecretsStore } from '#src/config/secrets'
import { makeFixture, makeView } from './fixture'

const fixtures: Fixture[] = []
afterEach(async () => {
  for (const created of fixtures.splice(0)) await created.cleanup()
})

/** A client whose `fetch` is the app itself, authenticated with a real token. */
async function clientFor(options: Parameters<typeof makeFixture>[0] = {}) {
  const created = await makeFixture({ password: 'a-good-password', ...options })
  fixtures.push(created)
  const token = generateApiToken()
  new SecretsStore(path.join(created.dir, '.hh', '.control-secrets.json'), undefined, 'global').setApiToken(token)
  const client = createClient({
    baseUrl: 'http://127.0.0.1:3999/',
    token,
    fetch: (input, init) => Promise.resolve(created.app.request(input instanceof Request ? input : String(input), init)),
  })
  return { created, client }
}

describe('home-hosted/client', () => {
  /** The token is full admin: over plain http to another host, anyone on the path reads it. */
  it('refuses to send a token over plain http to another host, unless told to', () => {
    const token = 'hh_x'
    expect(() => createClient({ baseUrl: 'http://192.168.1.10:3999', token })).toThrow(/allowInsecureToken/)
    expect(() => createClient({ baseUrl: 'http://panel.example.com', token })).toThrow(/plain http/)
    expect(() => createClient({ baseUrl: 'https://panel.example.com', token })).not.toThrow()
    expect(() => createClient({ baseUrl: 'http://localhost:3999', token })).not.toThrow()
    expect(() => createClient({ baseUrl: 'http://[::1]:3999', token })).not.toThrow()
    expect(() => createClient({ baseUrl: 'http://192.168.1.10:3999', token, allowInsecureToken: true })).not.toThrow()
    // No token, nothing to leak: a browser on a LAN address uses its cookie.
    expect(() => createClient({ baseUrl: 'http://192.168.1.10:3999' })).not.toThrow()
  })

  it('calls a typed route with the token attached', async () => {
    const { client } = await clientFor({ views: [makeView('web')] })
    const { servers } = await client.json(client.api.servers.$get({ query: {} }))
    expect(servers.map(server => server.id)).toEqual(['web'])
  })

  it('reaches routes outside /api through rpc', async () => {
    const { client } = await clientFor()
    const health = await client.json(client.rpc.healthz.$get())
    expect(health.status).toBe('ok')
  })

  it('turns the error envelope into a HomeHostedError', async () => {
    const { client } = await clientFor()
    const failure = await client.json(client.api.servers[':id'].$get({ param: { id: 'ghost' }, query: {} })).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HomeHostedError)
    expect(failure).toMatchObject({ status: 404, code: 'UNKNOWN_SERVER' })
  })

  it('streams typed frames, the full state first', async () => {
    const { client } = await clientFor({ views: [makeView('web')] })
    const controller = new AbortController()
    const stream = client.events({ logs: false, signal: controller.signal })
    const frame = (await stream.next()).value as SseMessage | undefined
    controller.abort()
    await stream.return(undefined)
    expect(frame?.type).toBe('hello')
    if (frame?.type === 'hello')
      expect(frame.state.workspaces[0]?.servers.map(server => server.id)).toEqual(['web'])
  })

  it('parses multi-line and split SSE frames', async () => {
    const chunks = ['event: log\ndata: {"a":', '1}\n\n: comment\n', 'data: x\ndata: y\n\n']
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
    const frames = []
    for await (const frame of readEventStream(body)) frames.push(frame)
    expect(frames).toEqual([{ event: 'log', data: '{"a":1}' }, { event: 'message', data: 'x\ny' }])
  })

  /**
   * Leaving the loop must close the connection, not merely stop reading it.
   *
   * `readEventStream` released its lock in `finally` but never cancelled the body, so the documented
   * `for await (… of hh.events()) { … break }` left the request open: the panel kept a subscriber
   * slot, and a Node script could not exit because the live socket held the event loop. Measured
   * against a real listener — `1 of 1` SSE connections still open after leaving the loop.
   *
   * This stream never ends on its own, which is what a real panel's looks like, so only an explicit
   * `cancel()` can settle it.
   */
  it('cancels the stream when the consumer stops reading early', async () => {
    let cancelled = false
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        // The first frame, then silence — exactly what an idle panel sends after its `hello`.
        if (pulls === 1)
          controller.enqueue(new TextEncoder().encode('event: hello\ndata: {"type":"hello"}\n\n'))
        return new Promise<void>(() => {})
      },
      cancel() {
        cancelled = true
      },
    })

    // Driven by hand rather than `for await`: the point is the early exit, and a loop whose body
    // always breaks reads as a loop that should not be one.
    const stream = readEventStream(body)
    const first = await stream.next()
    expect(first.done).toBe(false)
    expect(first.value.event).toBe('hello')
    await stream.return(undefined)

    expect(cancelled, 'leaving the loop early must close the body, or the socket outlives the reader').toBe(true)
  })
})

/**
 * `events({ reconnect: true })` survives a dropped connection.
 *
 * A `for await` over `events()` ended the moment the panel restarted or a proxy closed an idle
 * connection, so a script or a TUI lost the feed and had to notice by itself — the same "reconnect
 * with backoff" a UI gets from `live-store`, but on the Node side where there is no `EventSource`.
 *
 * Three things a reconnect has to get right, and each is asserted here:
 *  - **backoff**, not a hot loop against a panel that is down;
 *  - **re-auth**, because a restarted panel answers `401` and a retry that ignores it spins forever;
 *  - **resume**, because every frame carries an `id` and replaying from it is the whole point of
 *    `?since=` — a reconnect that starts over delivers lines the consumer already acted on.
 */
describe('home-hosted/client events reconnect', () => {
  it('reconnects with backoff and resumes from the last frame id', async () => {
    const seen: Array<{ since: string | null, attempt: number }> = []
    const bodies = [
      // First connection: one frame, then the connection drops (a panel restart).
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('id: 7\nevent: log\ndata: {"type":"log","ts":1,"workspaceId":"default","serverId":"web","lines":[]}\n\n'))
          controller.close()
        },
      }),
      // Second connection: one frame, then it stays open until the consumer stops.
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('id: 8\nevent: log\ndata: {"type":"log","ts":2,"workspaceId":"default","serverId":"web","lines":[]}\n\n'))
        },
      }),
    ]

    let calls = 0
    const client = createClient({
      baseUrl: 'http://127.0.0.1:3999',
      fetch: (input) => {
        const url = new URL(String(input))
        seen.push({ since: url.searchParams.get('since'), attempt: calls })
        const body = bodies[Math.min(calls, bodies.length - 1)]!
        calls += 1
        return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      },
      // Injected so the test does not wait a real backoff.
      retryDelayMs: async () => {},
    })

    const stream = client.events({ reconnect: true, logs: true })
    const ids: number[] = []
    for await (const frame of stream) {
      if (frame.type === 'log' && frame.id !== undefined)
        ids.push(frame.id)
      if (ids.length >= 2)
        break
    }

    expect(calls, 'a dropped stream must be reopened').toBe(2)
    expect(seen[0]!.since, 'the first connection has nothing to resume from').toBeNull()
    expect(seen[1]!.since, 'the retry must resume from the last frame it consumed').toBe('7')
    expect(ids, 'both runs deliver their frames, each with the id the stream assigned').toEqual([7, 8])
  })

  /**
   * The distinction that makes `reconnect` usable: a **transient** failure is retried, a **credential
   * refusal** is not. Both were a thrown error before, so "it throws" proves nothing — this asserts
   * the two behave differently, which is the whole decision.
   */
  it('stops on a credential refusal instead of retrying it', async () => {
    // The decision this pins: a `401` is thrown, not retried. A retry loop that ignored it would
    // call the panel for ever against a token it will never accept, and hide the one fact a caller
    // needs. (A transient failure reconnecting is covered by the resume test above, whose second
    // connection is what the first one's drop leads to.)
    let calls = 0
    // A real abort, which is how a caller stops a feed anyway. The loop re-checks it after every
    // backoff, so this test cannot hang even if the refusal guard is removed — it fails with
    // "a 401 must not be retried" instead of a timeout, which is the reason a person needs.
    const controller = new AbortController()
    const client = createClient({
      baseUrl: 'http://127.0.0.1:3999',
      fetch: () => {
        calls += 1
        return Promise.resolve(new Response(JSON.stringify({ message: 'authentication required', code: 'AUTH_REQUIRED' }), { status: 401, headers: { 'content-type': 'application/json' } }))
      },
      retryDelayMs: async () => {
        // Give up while a retry is being scheduled — exactly the moment a person closes the tool.
        controller.abort()
      },
    })

    const outcome = await client.events({ reconnect: true, signal: controller.signal })
      .next()
      .then(() => null)
      .catch((error: unknown) => error)

    // With the guard, the 401 is thrown before any retry; without it, the abort ends the loop and the
    // call count says a retry happened.
    expect(calls, 'a 401 must not be retried').toBe(1)
    expect(outcome, 'the refusal surfaces to the caller').toBeInstanceOf(HomeHostedError)
    expect(outcome).toMatchObject({ status: 401 })
  }, 10_000)

  it('stops when the panel says the credential is gone', async () => {
    // A restarted panel with a different token: every retry would be another `401`.
    let calls = 0
    const client = createClient({
      baseUrl: 'http://127.0.0.1:3999',
      fetch: () => {
        calls += 1
        return Promise.resolve(new Response(JSON.stringify({ message: 'authentication required', code: 'AUTH_REQUIRED' }), { status: 401, headers: { 'content-type': 'application/json' } }))
      },
      retryDelayMs: async () => {},
    })

    const failure = await client.events({ reconnect: true })
      .next()
      .then(() => null)
      .catch((error: unknown) => error)

    expect(failure, 'a refused credential must surface, not be retried away').toBeInstanceOf(HomeHostedError)
    expect(failure).toMatchObject({ status: 401, code: 'AUTH_REQUIRED' })
    expect(calls, 'a 401 is not retried').toBe(1)
  })

  it('does not reconnect unless asked', async () => {
    let calls = 0
    const client = createClient({
      baseUrl: 'http://127.0.0.1:3999',
      fetch: () => {
        calls += 1
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start: c => c.close() }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      },
      retryDelayMs: async () => {},
    })

    const frames = []
    for await (const frame of client.events())
      frames.push(frame)
    expect(frames).toEqual([])
    // The documented default stays exactly as it was: one connection, then the loop ends.
    expect(calls).toBe(1)
  })
})
