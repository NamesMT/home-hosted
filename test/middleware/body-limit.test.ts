import type { Fixture } from '../api/fixture'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_JSON_BODY_BYTES } from '#src/middleware/body-limit'
import { makeFixture, makeView } from '../api/fixture'

/**
 * A JSON body large enough to wreck the panel is refused, and one that is not is not.
 *
 * **Measured before the guard existed**: a `POST /api/servers` carrying a 19 MB `command` was accepted
 * (`201`), written to `servers.config.json`, and the state frame then became **20 MB** — a payload the
 * panel rebuilds every second and pushes over SSE to every open tab, and which `GET /api/settings` and
 * the config editor both have to read back. The caller was an authenticated admin, so this is not an
 * attack to defend against so much as a typo, a runaway script, or a paste of the wrong file, and it
 * makes the panel unusable from the moment it lands.
 *
 * The ceiling is 1 MB against a real request of ~400 bytes per server entry — a fifty-server config is
 * ~20 KB, a fifty-route proxy table ~15 KB — so the margin is two orders of magnitude.
 */
const fixtures: Fixture[] = []

async function fixture(): Promise<Fixture> {
  const created = await makeFixture({ password: 'admin-secret-123', views: [makeView('web')] })
  fixtures.push(created)
  return created
}

afterEach(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

/** Signs in and returns the cookie header a browser would send back. */
async function signIn(created: Fixture): Promise<string> {
  const response = await created.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'default', secret: 'admin-secret-123' }),
  })
  expect(response.status).toBe(200)
  return response.headers.get('set-cookie')!.split(';')[0]!
}

describe('the request body ceiling', () => {
  it('refuses a body over the limit before it reaches a config file', async () => {
    const created = await fixture()
    const cookie = await signIn(created)

    const huge = JSON.stringify({ id: 'x', command: 'A'.repeat(MAX_JSON_BODY_BYTES * 4) })
    /**
     * `content-length` is set by hand because `app.request()` does not.
     *
     * The guard reads the declared length — the only check that does not have to consume the stream, as
     * `createBodyLimitGuard` explains at length. A real client always declares one; `app.request()`
     * builds a `Request` in-process and declares nothing, which is also why the first version of this
     * case passed for the wrong reason and then failed once the guard stopped reading the body.
     */
    const response = await created.app.request('/api/servers?workspace=default', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'content-length': String(huge.length) },
      body: huge,
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
    // The point of the guard: the config the frame is built from is untouched.
    const config = created.store.servers
    expect(config.map(entry => entry.id), 'an oversized body reached the config file').not.toContain('x')
  })

  /**
   * A **bodiless** `POST` must not be refused, and must not throw.
   *
   * The first version of this guard used `hono/body-limit`, which re-wraps the request to re-read its
   * stream: `c.req.raw = new Request(c.req.raw, init)`. Against srvx the raw request carries a *relative*
   * URL, so that constructor throws `Failed to parse URL from [object Request]` (`[cause]: Invalid URL`)
   * and **every bodiless `POST` answered 500** — `start`, `stop`, `backup create`. Measured against a
   * built panel; the fixture did not see it because it builds a plain `Request` with an absolute URL,
   * where the rewrap succeeds. So the guard reads `content-length` and never touches the stream.
   *
   * This case is therefore as much about *this* test suite's limits as about the route: it passes
   * against the fixture either way, and what it pins is that no regressed guard turns a lifecycle call
   * into a 500.
   */
  it('lets a bodiless POST through, which is every lifecycle action', async () => {
    const created = await fixture()
    const cookie = await signIn(created)

    const response = await created.app.request('/api/servers/web/start?workspace=default', {
      method: 'POST',
      headers: { cookie },
    })
    expect(response.status, 'a bodiless POST was refused or threw').not.toBe(500)
    expect(response.status).not.toBe(413)
  })

  it('accepts a body of a realistic size', async () => {
    // Anti-vacuity: a guard that refused everything would satisfy the case above and break the panel.
    const created = await fixture()
    const cookie = await signIn(created)

    const response = await created.app.request('/api/servers?workspace=default', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'real', command: process.execPath, args: ['-e', '0'] }),
    })
    expect(response.status).toBe(201)
    expect(created.store.servers.map(entry => entry.id)).toContain('real')
  })

  it('lets the backup restore upload through, whose body is an archive and not JSON', async () => {
    /**
     * The first version of the guard refused this with `413`. A middleware installed at `/api/*` runs
     * before the route's own `bodyLimit`, so the upload's larger ceiling never applied — a 3 MB archive
     * was rejected by a 1 MB JSON limit. Verified against a running panel, which is how it was found.
     */
    const created = await fixture()
    const cookie = await signIn(created)

    // An upload of a size the JSON ceiling would refuse; the route's own validator rejects the *content*,
    // which is the answer we want — anything but `413 PAYLOAD_TOO_LARGE`.
    const response = await created.app.request('/api/backups/restore', {
      method: 'POST',
      headers: { cookie, 'content-type': 'multipart/form-data; boundary=x' },
      body: `--x\r\nContent-Disposition: form-data; name="file"; filename="a.zip"\r\n\r\n${'P'.repeat(MAX_JSON_BODY_BYTES * 2)}\r\n--x--\r\n`,
    })
    expect(response.status, 'the upload was refused by the JSON ceiling instead of reaching its route').not.toBe(413)
  })
})
