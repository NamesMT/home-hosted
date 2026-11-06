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
