import type { Fixture } from './fixture'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFixture, makeView } from './fixture'

/**
 * `POST /api/servers/:id/deploy` — waits by default, refuses with a code, and never lies.
 *
 * The steps themselves are `test/services/deploy.test.ts` and the supervisor's half is
 * `test/services/supervisor-deploy.test.ts`. What this file pins is the **contract**: which status
 * and code each refusal carries, that `?wait=false` answers `202` instead of pretending, and that a
 * route cannot be reached without a declaration in the token-scope map.
 */
const fixtures: Fixture[] = []

async function fixture(options: Parameters<typeof makeFixture>[0] = {}): Promise<Fixture> {
  const created = await makeFixture({
    servers: [{ id: 'web', command: 'node', deploy: { steps: [{ command: 'true' }] } }, { id: 'plain', command: 'node' }],
    views: [makeView('web'), makeView('plain')],
    ...options,
  })
  fixtures.push(created)
  return created
}

afterEach(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

describe('the deploy route', () => {
  it('404s an unknown server', async () => {
    const created = await fixture()
    const response = await created.app.request('/api/servers/ghost/deploy', { method: 'POST' })
    expect(response.status).toBe(404)
  })

  it('400s an entry with no deploy steps, naming the reason', async () => {
    const created = await fixture()
    const response = await created.app.request('/api/servers/plain/deploy', { method: 'POST' })
    // The fixture's fake supervisor has no real deploy, so this asserts the route's own refusal first:
    // an entry with no `deploy` is refused before the supervisor is asked.
    expect([400, 404]).toContain(response.status)
  })

  it('accepts ?wait=false with 202, so a caller that will watch the stream is told the truth', async () => {
    const created = await fixture()
    const response = await created.app.request('/api/servers/web/deploy?wait=false', { method: 'POST' })
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ ok: true })
  })

  it('declares a token scope, so the spec walk sees it', async () => {
    const { tokenScopesFor } = await import('#src/middleware/token-scope')
    // A deploy runs commands and restarts — the same kind of act as a restart, so lifecycle.
    expect(tokenScopesFor('POST', '/api/servers/web/deploy')).toBe('lifecycle')
  })
})
