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
    const { servers } = await client.json(client.api.api.servers.$get({ query: {} }))
    expect(servers.map(server => server.id)).toEqual(['web'])
  })

  it('turns the error envelope into a HomeHostedError', async () => {
    const { client } = await clientFor()
    const failure = await client.json(client.api.api.servers[':id'].$get({ param: { id: 'ghost' }, query: {} })).catch((error: unknown) => error)
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
})
