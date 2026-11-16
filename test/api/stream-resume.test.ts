import type { Fixture } from './fixture'
import { afterAll, describe, expect, it } from 'vitest'
import { makeFixture, makeView } from './fixture'

/**
 * Resumable streams: the `id:` on every frame, `retry:` on open, and what a reconnect is answered with.
 *
 * The contract these pin is the one a UI author reads: every frame carries a monotonic `id`, a
 * reconnecting client sends the last one it saw (`Last-Event-ID`, or `?since=` for a `fetch` reader),
 * and the stream answers with **one current snapshot first, then the replay** of buffered `log` frames
 * published after it. A snapshot is never replayed — that would roll the client's state backwards.
 */

const fixtures: Fixture[] = []

async function fixture(): Promise<Fixture> {
  const created = await makeFixture({ views: [makeView('web')] })
  fixtures.push(created)
  return created
}

afterAll(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

/** Reads SSE frames until `done` says stop, or the deadline passes. */
async function readFrames(reader: ReadableStreamDefaultReader<Uint8Array>, decoder: InstanceType<typeof TextDecoder>, text: string, done: (all: string) => boolean, timeoutMs = 2000): Promise<string> {
  let all = text
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !done(all)) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>(resolve => setTimeout(resolve, Math.max(1, deadline - Date.now()), null)),
    ])
    if (chunk === null || chunk.done)
      break
    all += decoder.decode(chunk.value, { stream: true })
  }
  return all
}

/** The `id:` values in the order they arrived. */
function ids(text: string): number[] {
  return [...text.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]))
}

/** One `log` frame's texts, in arrival order. */
function logTexts(text: string): string[] {
  return [...text.matchAll(/"text":"([^"]*)"/g)].map(match => match[1]!)
}

describe('resumable event stream', () => {
  it('puts a monotonic id on every frame and a retry hint on the first', async () => {
    const created = await fixture()
    const response = await created.app.request('/api/events?logs=0')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    const text = await readFrames(reader, decoder, '', all => ids(all).length >= 2, 3000)
    await reader.cancel().catch(() => {})

    const sequences = ids(text)
    expect(sequences.length, 'the opening snapshot carries an id').toBeGreaterThanOrEqual(1)
    // `0` is a real cursor: "state as of sequence 0" is a panel that has published nothing yet, and
    // a client resuming from it is replayed the whole (short) buffer.
    expect(sequences[0], 'the first frame is numbered').toBeGreaterThanOrEqual(0)
    for (let index = 1; index < sequences.length; index++)
      expect(sequences[index]!, 'ids never go backwards').toBeGreaterThanOrEqual(sequences[index - 1]!)

    // `retry:` is on the connection, not every frame: exactly one in what arrived.
    expect([...text.matchAll(/^retry: (\d+)$/gm)]).toHaveLength(1)
  })

  /**
   * A resumed stream answers with one current snapshot, then the lines the client missed.
   *
   * The snapshot is *current*, so its id is at or above every replayed frame's: a client reading in
   * order sees the fresh state first and log lines that predate it, which is the ordering the docs
   * promise. Replaying a `state`/`server` frame instead would hand back stale state.
   */
  it('replays the log frames after ?since=, behind one current snapshot', async () => {
    const created = await fixture()
    // Two lines the client has, one it does not.
    created.hub.publish({ type: 'log', ts: 1, workspaceId: created.defaultId, serverId: 'web', lines: [{ ts: 1, stream: 'stdout', text: 'seen-1' }] })
    created.hub.publish({ type: 'log', ts: 2, workspaceId: created.defaultId, serverId: 'web', lines: [{ ts: 2, stream: 'stdout', text: 'seen-2' }] })
    const lastSeen = created.hub.lastSeq
    created.hub.publish({ type: 'log', ts: 3, workspaceId: created.defaultId, serverId: 'web', lines: [{ ts: 3, stream: 'stdout', text: 'missed' }] })

    const response = await created.app.request(`/api/events?since=${lastSeen}`)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const text = await readFrames(reader, decoder, '', all => all.includes('missed'), 3000)
    await reader.cancel().catch(() => {})

    // The snapshot comes first…
    expect(text.indexOf('event: hello')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('event: hello')).toBeLessThan(text.indexOf('missed'))
    // …the missed line is replayed, the seen ones are not.
    const texts = logTexts(text)
    expect(texts).toContain('missed')
    expect(texts, 'a line the client already has is not replayed').not.toContain('seen-1')
    expect(texts).not.toContain('seen-2')
  })

  it('honours the Last-Event-ID header a reconnecting EventSource sends', async () => {
    const created = await fixture()
    created.hub.publish({ type: 'log', ts: 1, workspaceId: created.defaultId, serverId: 'web', lines: [{ ts: 1, stream: 'stdout', text: 'before' }] })
    const lastSeen = created.hub.lastSeq
    created.hub.publish({ type: 'log', ts: 2, workspaceId: created.defaultId, serverId: 'web', lines: [{ ts: 2, stream: 'stdout', text: 'after' }] })

    const response = await created.app.request('/api/events', { headers: { 'Last-Event-ID': String(lastSeen) } })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const text = await readFrames(reader, decoder, '', all => all.includes('after'), 3000)
    await reader.cancel().catch(() => {})

    const texts = logTexts(text)
    expect(texts).toContain('after')
    expect(texts).not.toContain('before')
  })

  /** `?since=` wins over the header, and a malformed header never replays the whole buffer. */
  it('prefers ?since= over the header and ignores a malformed Last-Event-ID', async () => {
    const created = await fixture()
    created.hub.publish({ type: 'log', ts: 1, workspaceId: created.defaultId, serverId: 'web', lines: [{ ts: 1, stream: 'stdout', text: 'line-a' }] })
    created.hub.publish({ type: 'log', ts: 2, workspaceId: created.defaultId, serverId: 'web', lines: [{ ts: 2, stream: 'stdout', text: 'line-b' }] })

    // The header says "from the start", the query says "after both": the query is what the caller wrote on purpose.
    const response = await created.app.request(`/api/events?since=${created.hub.lastSeq}`, { headers: { 'Last-Event-ID': '0' } })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const text = await readFrames(reader, decoder, '', all => all.includes('event: hello'), 2000)
    await reader.cancel().catch(() => {})

    const texts = logTexts(text)
    expect(texts, 'the query wins, so nothing is replayed').not.toContain('line-a')
    expect(texts).not.toContain('line-b')
  })

  it('ignores a Last-Event-ID that is not a number', async () => {
    const created = await fixture()
    created.hub.publish({ type: 'log', ts: 1, workspaceId: created.defaultId, serverId: 'web', lines: [{ ts: 1, stream: 'stdout', text: 'old' }] })

    const response = await created.app.request('/api/events', { headers: { 'Last-Event-ID': 'not-a-number' } })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const text = await readFrames(reader, decoder, '', all => all.includes('event: hello'), 2000)
    await reader.cancel().catch(() => {})

    // Unreadable, so it resumes from nothing — not from `NaN`, which replayed the buffer to a client
    // that asked for no replay at all.
    expect(logTexts(text)).not.toContain('old')
  })

  it('still refuses an unknown workspace before opening a resumable stream', async () => {
    const created = await fixture()
    const response = await created.app.request('/api/events?workspace=nope&since=0')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'UNKNOWN_WORKSPACE' })
  })

  it('refuses a non-numeric ?since=', async () => {
    const created = await fixture()
    for (const since of ['abc', '1.5', '-1', '']) {
      const response = await created.app.request(`/api/events?since=${since}`)
      expect(response.status, `since=${since}`).toBe(400)
      expect(await response.json(), `since=${since}`).toMatchObject({ code: 'INVALID_INPUT' })
    }
  })

  it('does not replay a log frame the client asked not to receive', async () => {
    const created = await fixture()
    created.hub.publish({ type: 'log', ts: 1, workspaceId: created.defaultId, serverId: 'web', lines: [{ ts: 1, stream: 'stdout', text: 'chatty' }] })

    const response = await created.app.request('/api/events?since=0&logs=0')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const text = await readFrames(reader, decoder, '', all => all.includes('event: hello'), 2000)
    await reader.cancel().catch(() => {})

    expect(logTexts(text)).not.toContain('chatty')
  })
})

describe('resumable per-server stream', () => {
  it('carries ids and replays its own server’s missed lines after ?since=', async () => {
    const created = await fixture()
    created.hub.publish({ type: 'log', ts: 1, workspaceId: created.defaultId, serverId: 'web', lines: [{ ts: 1, stream: 'stdout', text: 'old-line' }] })
    const lastSeen = created.hub.lastSeq
    created.hub.publish({ type: 'log', ts: 2, workspaceId: created.defaultId, serverId: 'web', lines: [{ ts: 2, stream: 'stdout', text: 'new-line' }] })

    const response = await created.app.request(`/api/servers/web/stream?since=${lastSeen}`)
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const text = await readFrames(reader, decoder, '', all => all.includes('new-line'), 3000)
    await reader.cancel().catch(() => {})

    expect(ids(text).length, 'every frame carries an id').toBeGreaterThan(0)
    expect(logTexts(text)).toContain('new-line')
    expect(logTexts(text), 'the line already seen is not replayed').not.toContain('old-line')
  })

  it('seeds a fresh stream with the buffered lines and no replay duplication', async () => {
    const created = await fixture()
    const response = await created.app.request('/api/servers/web/stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const text = await readFrames(reader, decoder, '', all => all.includes('event: log'), 2000)
    await reader.cancel().catch(() => {})

    expect(text).toContain('event: server')
    expect(text).toContain('event: log')
    expect([...text.matchAll(/^retry: /gm)], 'retry is once, on the opening frame').toHaveLength(1)
  })

  it('refuses an unknown server before opening the stream', async () => {
    const created = await fixture()
    expect((await created.app.request('/api/servers/ghost/stream?since=0')).status).toBe(404)
  })

  it('refuses an undeclared query key on the stream route', async () => {
    const created = await fixture()
    const response = await created.app.request('/api/servers/web/stream?worspace=staging')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_INPUT' })
  })
})

/**
 * A workspace-limited credential watches only the workspaces it names.
 *
 * The live feed is the one `/api` read `?workspace=` does not narrow on its own: it also carries a
 * `log` frame for **every** workspace, so declared panel-wide it handed an account limited to
 * `staging` the default workspace's output. Measured before this test: a `staging`-limited `read`
 * account opened `/api/events?logs=1` with no query at all and received `DEFAULT-LEAK` from
 * `default`'s `web`, while `GET /api/logs?workspace=default` refused the same account — a limit that
 * held on the polling route and not on the streaming one, which makes the stream the cheap way to
 * watch a workspace you may not read.
 *
 * Naming a workspace the credential may not read is the polling route's refusal (not an empty
 * stream: silence reads as "nothing is happening"), and the panel-wide stream a UI opens with no
 * query still works — it is filtered to the account's own workspaces rather than refused.
 */
describe('a workspace-limited credential on the live feed', () => {
  async function limitedFixture(): Promise<{ created: Fixture, headers: Record<string, string> }> {
    const created = await makeFixture({ workspaces: [{ id: 'staging' }] })
    fixtures.push(created)
    const { secret } = created.globalSecrets.createAccount({ id: 'limited', label: 'limited', scopes: ['read'], workspaces: ['staging'] })
    return { created, headers: { authorization: `Bearer limited:${secret}` } }
  }

  it('is refused a workspace it does not name', async () => {
    const { created, headers } = await limitedFixture()
    const response = await created.app.request('/api/events?workspace=default', { headers })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'TOKEN_SCOPE' })
  })

  it('receives no frame from a workspace it does not name, and still receives its own', async () => {
    const { created, headers } = await limitedFixture()
    const response = await created.app.request('/api/events?logs=1', { headers })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    await readFrames(reader, decoder, '', all => all.includes('event: hello'), 3000)

    created.hub.publish({ type: 'log', ts: Date.now(), workspaceId: 'default', serverId: 'web', lines: [{ ts: 1, stream: 'stdout', text: 'DEFAULT-LEAK' }] })
    created.hub.publish({ type: 'log', ts: Date.now(), workspaceId: 'staging', serverId: 'stg', lines: [{ ts: 2, stream: 'stdout', text: 'OWN-OK' }] })

    const text = await readFrames(reader, decoder, '', all => all.includes('OWN-OK'), 3000)
    await reader.cancel().catch(() => {})
    expect(logTexts(text), 'its own workspace is delivered').toContain('OWN-OK')
    expect(logTexts(text), 'another workspace is not').not.toContain('DEFAULT-LEAK')
  })

  /**
   * The **snapshot** frames are narrowed too, not merely the per-frame `workspaceId` ones.
   *
   * Filtering on `workspaceId` covered `server` and `log` frames only, and left `hello`/`state` whole
   * on the reasoning that they are "panel-wide". They are panel-wide in the sense that they carry
   * every workspace — which is exactly why a limited credential's copy has to be cut down: the state
   * payload is `workspaces[].servers[]`, the same `ServerView` its polling sibling refuses. Measured
   * on a fixture whose `default` holds `secret-svc`, a `staging`-limited `read` account's opening
   * `hello` frame carried `"default"`, the command `node --api-key=SUPERSECRET` and pid `4242`.
   */
  it('narrows the opening snapshot and every later state frame to its own workspaces', async () => {
    const created = await makeFixture({
      workspaces: [{ id: 'staging' }],
      servers: [{ id: 'secret-svc', command: 'node --api-key=SUPERSECRET' }],
      views: [makeView('secret-svc', {
        config: { id: 'secret-svc', command: 'node --api-key=SUPERSECRET', enabled: true, label: 'private' } as never,
        status: 'running',
        pid: 4242,
      })],
    })
    fixtures.push(created)
    const { secret } = created.globalSecrets.createAccount({ id: 'limited', label: 'limited', scopes: ['read'], workspaces: ['staging'] })
    const headers = { authorization: `Bearer limited:${secret}` }

    const response = await created.app.request('/api/events', { headers })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const hello = await readFrames(reader, decoder, '', all => all.includes('event: hello'), 3000)

    expect(hello, 'the account\'s own workspace is named').toContain('"staging"')
    expect(hello, 'another workspace\'s server id is not').not.toContain('secret-svc')
    expect(hello, 'nor its command').not.toContain('SUPERSECRET')
    expect(hello, 'nor its live pid').not.toContain('4242')

    // The periodic frame goes through the same narrowing: the hub publishes the whole panel.
    created.panel.getState()
    created.hub.publish({ type: 'state', ts: Date.now(), state: created.panel.getState() })
    const later = await readFrames(reader, decoder, hello, all => all.includes('event: state'), 3000)
    await reader.cancel().catch(() => {})
    expect(later, 'the later frame carries its own workspace').toContain('"staging"')
    expect(later, 'and not another workspace\'s server').not.toContain('secret-svc')

    // An unlimited credential keeps the whole panel.
    const admin = created.globalSecrets.createAccount({ id: 'wide', label: 'wide', scopes: ['read'] })
    const wide = await created.app.request('/api/events', { headers: { authorization: `Bearer wide:${admin.secret}` } })
    const wideReader = wide.body!.getReader()
    const wideHello = await readFrames(wideReader, decoder, '', all => all.includes('event: hello'), 3000)
    await wideReader.cancel().catch(() => {})
    expect(wideHello, 'an unlimited credential sees every workspace').toContain('"default"')
    expect(wideHello).toContain('secret-svc')
  })

  /**
   * The limit is answered **before** the server id is looked up, so the two cannot be told apart.
   *
   * The reverse order made the pair an existence oracle over another workspace's server ids: a
   * `staging`-limited `read` account asked for one of `default`'s entries and got `403 TOKEN_SCOPE`,
   * and for an id that does not exist and got `404 UNKNOWN_SERVER` — the second answer says "that one
   * is not there", which is a fact about a workspace the account may not read. Measured on a scratch
   * panel: `?serverId=secret-svc` answered `403` and `?serverId=no-such-thing` answered `404`.
   *
   * A caller that may not watch the workspace gets the same `403` either way, and its own workspace
   * still distinguishes a real id from a typo, which is the diagnostic that matters.
   */
  it('refuses another workspace before it says whether the server id exists', async () => {
    const created = await makeFixture({
      workspaces: [{ id: 'staging', servers: [{ id: 'stg', command: 'node' }] }],
      servers: [{ id: 'secret-svc', command: 'node' }],
    })
    fixtures.push(created)
    const { secret } = created.globalSecrets.createAccount({ id: 'oracle', scopes: ['read'], workspaces: ['staging'] })
    const headers = { authorization: `Bearer oracle:${secret}` }

    for (const serverId of ['secret-svc', 'no-such-thing']) {
      const response = await created.app.request(`/api/events?serverId=${serverId}`, { headers })
      expect(response.status, `${serverId} must not be distinguishable`).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'TOKEN_SCOPE' })
    }

    // Its own workspace still answers the useful pair: 404 for a typo, a stream for a real entry.
    expect((await created.app.request('/api/events?workspace=staging&serverId=no-such-thing', { headers })).status).toBe(404)
    const own = await created.app.request('/api/events?workspace=staging&serverId=stg', { headers })
    expect(own.status).toBe(200)
    await own.body!.getReader().cancel().catch(() => {})
  })
})
