import type { Fixture } from './fixture'
import { afterAll, describe, expect, it } from 'vitest'
import { makeFixture } from './fixture'

/**
 * Log cursors: `?since=` and `?before=` on `GET /api/logs/:id`.
 *
 * A cursor is a line's `ts`. The two halves are exclusive, so a client polling forward with `since`
 * and backfilling with `before` never sees a line twice; and a cursor the route cannot reach is
 * **refused**, never answered with a short list — `lines: []` reads as "nothing was logged", which is
 * the one thing a log route must not say when it simply did not read far enough.
 */

const fixtures: Fixture[] = []

async function withServer(): Promise<Fixture> {
  const created = await makeFixture({ servers: [{ id: 'web', command: 'node', autostart: true }] })
  fixtures.push(created)
  return created
}

afterAll(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

/** `count` lines whose `ts` is their index, so a cursor is easy to name in an assertion. */
function seedLogs(created: Fixture, count: number): void {
  for (let index = 0; index < count; index++)
    created.logFiles.append('web', { ts: index, stream: index % 2 === 0 ? 'stdout' : 'stderr', text: `line-${index}` })
  // `append` is buffered on a hot path, so a test has to flush before it can read the file back.
  created.logFiles.flush()
}

interface History {
  lines: Array<{ ts: number, stream: string, text: string }>
  searched: number | null
}

describe('log cursors', () => {
  it('returns the lines after ?since=, oldest first, so a client can page forward', async () => {
    const created = await withServer()
    seedLogs(created, 80)

    const body = await (await created.app.request('/api/logs/web?since=69')).json() as History
    expect(body.lines.map(line => line.ts)).toEqual([70, 71, 72, 73, 74, 75, 76, 77, 78, 79])
  })

  it('returns the lines before ?before=, newest last', async () => {
    const created = await withServer()
    seedLogs(created, 80)

    const body = await (await created.app.request('/api/logs/web?before=10')).json() as History
    expect(body.lines.map(line => line.ts)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('keeps the two cursors complementary, so a client sees no line twice', async () => {
    const created = await withServer()
    seedLogs(created, 60)

    const forward = await (await created.app.request('/api/logs/web?since=19&tail=5000')).json() as History
    const backward = await (await created.app.request('/api/logs/web?before=20&tail=5000')).json() as History
    const overlap = forward.lines.map(line => line.ts).filter(ts => backward.lines.some(line => line.ts === ts))
    // The cursor itself belongs to neither half: `since` is exclusive, `before` is exclusive.
    expect(overlap).toEqual([])
    expect(backward.lines.map(line => line.ts)).not.toContain(20)
    expect(forward.lines.map(line => line.ts)).not.toContain(19)
  })

  it('pages forward with the last id it received, and reports running out honestly', async () => {
    const created = await withServer()
    seedLogs(created, 120)

    const first = await (await created.app.request('/api/logs/web?since=0&tail=50')).json() as History
    expect(first.lines).toHaveLength(50)
    expect(first.lines[0]!.ts).toBe(1)
    expect(first.lines.at(-1)!.ts).toBe(50)

    const next = await (await created.app.request(`/api/logs/web?since=${first.lines.at(-1)!.ts}&tail=50`)).json() as History
    expect(next.lines[0]!.ts).toBe(51)
    expect(next.lines.at(-1)!.ts).toBe(100)

    const last = await (await created.app.request(`/api/logs/web?since=${next.lines.at(-1)!.ts}&tail=50`)).json() as History
    expect(last.lines.map(line => line.ts)).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119])
  })

  it('applies a stream filter before the cursor, so a page is really that stream', async () => {
    const created = await withServer()
    seedLogs(created, 100)

    const body = await (await created.app.request('/api/logs/web?since=19&stream=stderr')).json() as History
    expect(body.lines.length).toBeGreaterThan(0)
    expect(body.lines.every(line => line.stream === 'stderr')).toBe(true)
    expect(body.lines.every(line => line.ts > 19)).toBe(true)
  })

  it('keeps the plain tail behaviour when neither cursor is named', async () => {
    const created = await withServer()
    seedLogs(created, 60)

    const body = await (await created.app.request('/api/logs/web?tail=50')).json() as History
    expect(body.lines).toHaveLength(50)
    expect(body.lines.at(-1)!.ts).toBe(59)
    expect(body.searched).toBeNull()
  })

  /**
   * A cursor the route cannot reach is refused, not answered with a short list.
   *
   * The route reads at most `MAX_TAIL` lines. A `since` older than the oldest line it read means
   * lines are on disk that were not looked at, and answering with what happened to be in the window —
   * or with `[]` — would tell the caller "nothing was logged in between". The refusal names the way
   * to read the whole history.
   */
  it('refuses a cursor older than the window it can read, rather than clamping', async () => {
    const created = await withServer()
    seedLogs(created, 6000)

    const response = await created.app.request('/api/logs/web?since=0')
    expect(response.status).toBe(400)
    const body = await response.json() as { code: string, message: string }
    expect(body.code).toBe('CURSOR_OUT_OF_RANGE')
    expect(body.message).toContain('download')
  })

  it('refuses a since that is not before the before of the same request', async () => {
    const created = await withServer()
    seedLogs(created, 60)

    const response = await created.app.request('/api/logs/web?since=40&before=20')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('refuses a negative or fractional cursor at the boundary', async () => {
    const created = await withServer()
    seedLogs(created, 60)

    for (const value of ['-1', '1.5', 'abc', '1e3', ' ']) {
      const response = await created.app.request(`/api/logs/web?since=${encodeURIComponent(value)}`)
      expect(response.status, `since=${value}`).toBe(400)
      expect(await response.json(), `since=${value}`).toMatchObject({ code: 'INVALID_INPUT' })
    }
  })

  it('keeps search, stream and cursor working together', async () => {
    const created = await withServer()
    seedLogs(created, 200)

    const body = await (await created.app.request('/api/logs/web?stream=stderr&search=line-1&since=99&tail=50')).json() as History
    expect(body.lines.every(line => line.stream === 'stderr')).toBe(true)
    expect(body.lines.every(line => line.text.includes('line-1'))).toBe(true)
    expect(body.lines.every(line => line.ts > 99)).toBe(true)
  })

  it('404s the cursors of a server the config does not know', async () => {
    const created = await withServer()
    expect((await created.app.request('/api/logs/ghost?since=0')).status).toBe(404)
    expect((await created.app.request('/api/logs/ghost?before=10')).status).toBe(404)
  })
})
