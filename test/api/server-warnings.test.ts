import type { Fixture } from './fixture'
import { afterAll, describe, expect, it } from 'vitest'
import { makeFixture } from './fixture'

/**
 * A create that will fail at spawn says so **now**, not after burning every retry.
 *
 * `command` is a program, not a command line: it is spawned with no shell, so `"node server.js"`
 * asks for a program of that name. The entry was accepted with `201` and only failed at spawn —
 * then retried `restart.maxRetries` times, each with the same `ENOENT`, before the card read
 * "gave up after 3 retries". The person had already been told it was created.
 *
 * The create still succeeds (a warning is not a refusal: the entry may be valid on another machine,
 * and the panel does not execute anything to find out), and answers an optional `warnings` list — a
 * response field, so absent on an older panel and never required by a client.
 */

const fixtures: Fixture[] = []

async function fixture(): Promise<Fixture> {
  const created = await makeFixture()
  fixtures.push(created)
  return created
}

afterAll(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

interface CreateResponse {
  server: { id: string, command: string, args: string[] }
  warnings?: string[]
}

describe('a create warns about an entry that cannot start', () => {
  it('warns when `command` holds a whole command line', async () => {
    const created = await fixture()
    const response = await created.app.request('/api/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'web', command: 'node server.js' }),
    })

    expect(response.status, 'a warning is not a refusal').toBe(201)
    const body = await response.json() as CreateResponse
    expect(body.warnings, 'the create must say what is wrong with it').toBeDefined()
    expect(body.warnings!.length).toBe(1)
    // The advice names the config keys, so it is actionable in a config file and in the API.
    expect(body.warnings![0]).toContain('`command`')
    expect(body.warnings![0]).toContain('`args`')
  })

  it('says nothing for an ordinary entry', async () => {
    const created = await fixture()
    const body = await (await created.app.request('/api/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'web', command: 'node', args: ['server.js'] }),
    })).json() as CreateResponse

    // Absent, not an empty list: a client reading `warnings.length` on every create is noise.
    expect(body).not.toHaveProperty('warnings')
  })

  it('warns on a PUT too, since that is the config-management path', async () => {
    const created = await fixture()
    const body = await (await created.app.request('/api/servers/web', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'web', command: 'python app.py' }),
    })).json() as CreateResponse

    expect(body.warnings?.[0]).toContain('`args`')
  })

  /** The offline `add` path shares the helper, so the CLI cannot disagree with the API. */
  it('is the one helper both transports use', async () => {
    const { serverWarnings } = await import('#src/helpers/server-create')
    expect(serverWarnings({ command: 'node server.js', args: [] })).toHaveLength(1)
    expect(serverWarnings({ command: 'node', args: ['server.js'] })).toEqual([])
    expect(serverWarnings({ command: 'C:\\Program Files\\app\\app.exe', args: [] }), 'a path with a space is a program').toEqual([])
  })
})
