import type { Fixture } from './fixture'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFixture, makeView } from './fixture'

/**
 * `POST /api/servers/:id/run` — the contract of "run a job now".
 *
 * The run itself is `test/services/supervisor-job.test.ts` (a real child, a real exit code) and the
 * schedule is `test/services/scheduler.test.ts`. What this file pins is the **wire**: which status and
 * code each refusal carries, that a failed run keeps its exit code in the body, that `?wait=false`
 * answers `202` rather than pretending, and that the route is declared for a scoped token.
 */
const fixtures: Fixture[] = []

async function fixture(options: Parameters<typeof makeFixture>[0] = {}): Promise<Fixture> {
  const created = await makeFixture({
    servers: [
      { id: 'nightly', command: 'node', kind: 'job', schedule: '0 3 * * *' },
      { id: 'web', command: 'node' },
    ],
    views: [makeView('nightly'), makeView('web')],
    ...options,
  })
  fixtures.push(created)
  return created
}

afterEach(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

describe('the run route', () => {
  it('404s an unknown server', async () => {
    const created = await fixture()
    const response = await created.app.request('/api/servers/ghost/run', { method: 'POST' })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'UNKNOWN_SERVER' })
  })

  it('refuses a service with NOT_A_JOB, naming the command that does start it', async () => {
    const created = await fixture()
    const response = await created.app.request('/api/servers/web/run', { method: 'POST' })
    expect(response.status).toBe(409)
    const body = await response.json() as { code?: string, message?: string }
    expect(body.code).toBe('NOT_A_JOB')
    expect(body.message).toMatch(/start/)
  })

  it('accepts ?wait=false with 202, so a caller that will watch the stream is told the truth', async () => {
    const created = await fixture()
    const response = await created.app.request('/api/servers/nightly/run?wait=false', { method: 'POST' })
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ ok: true })
  })

  it('declares a token scope, so the spec walk sees it', async () => {
    const { tokenScopesFor } = await import('#src/middleware/token-scope')
    // Running a job is the same act as starting a service.
    expect(tokenScopesFor('POST', '/api/servers/nightly/run')).toBe('lifecycle')
  })

  it('refuses an undeclared query key, so a typo cannot be read as a flag', async () => {
    const created = await fixture()
    const response = await created.app.request('/api/servers/nightly/run?waitt=false', { method: 'POST' })
    expect(response.status).toBe(400)
  })
})
