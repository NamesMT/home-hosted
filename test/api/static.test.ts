import type { Fixture } from './fixture'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFixture } from './fixture'

/**
 * What the static catch-all promises a browser and a build.
 *
 * Two separate promises, both of which were wrong:
 *
 * 1. **Caching.** Every name under `/assets/` was cached for a year, whether or not it was
 *    content-hashed — so a UI rebuilt with a hand-named `assets/logo.svg` (or any of the
 *    unhashed files a non-Vite build puts there) was frozen in visitors' browsers. And a
 *    hashed name was only recognised by its directory, never by its hash.
 * 2. **A miss.** Anything the route could not find was answered with `index.html` and a 200,
 *    including `/assets/app-1a2b3c4d.js` — a request a browser parses as JavaScript. HTML there
 *    is a syntax error, and it turns a genuinely broken build into a blank page instead of a
 *    visible 404 in the network tab. A client route (`/servers/web`) must still work on refresh,
 *    so extension-less paths keep the fallback.
 */

const fixtures: Fixture[] = []

async function fixture(): Promise<Fixture> {
  const created = await makeFixture()
  fixtures.push(created)
  return created
}

afterEach(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

/** A file in the served UI root, created for one assertion. */
function write(root: string, name: string, content = 'x'): void {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

describe('static assets: caching', () => {
  it('caches a content-hashed asset for a year, and revalidates every other name', async () => {
    const created = await fixture()
    const root = created.ui.resolveDir()
    write(root, 'assets/index-CnBN54wF.js', 'console.log(1)')
    // A build that does not hash — a hand-written UI, or `public/` files copied verbatim.
    write(root, 'assets/logo.svg', '<svg/>')
    write(root, 'favicon.ico', 'icon')

    const hashed = await created.app.request('/assets/index-CnBN54wF.js')
    expect(hashed.status).toBe(200)
    expect(hashed.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')

    // The same directory, no hash in the name: the file's bytes can change under this URL.
    const unhashed = await created.app.request('/assets/logo.svg')
    expect(unhashed.status).toBe(200)
    expect(unhashed.headers.get('cache-control')).toBe('no-cache')

    const icon = await created.app.request('/favicon.ico')
    expect(icon.status).toBe(200)
    expect(icon.headers.get('cache-control')).toBe('no-cache')

    // The entry document above all: a cached shell points at hashed names a new build deleted.
    const index = await created.app.request('/')
    expect(index.status).toBe(200)
    expect(index.headers.get('cache-control')).toBe('no-cache')
  })

  it('does not read a version or a size in a name as a content hash', async () => {
    const created = await fixture()
    const root = created.ui.resolveDir()
    write(root, 'assets/icon-48px.svg', '<svg/>')
    write(root, 'assets/app-v2.woff2', 'font')

    for (const url of ['/assets/icon-48px.svg', '/assets/app-v2.woff2']) {
      const response = await created.app.request(url)
      expect(response.status, url).toBe(200)
      expect(response.headers.get('cache-control'), url).toBe('no-cache')
    }
  })
})

describe('static assets: a missing file', () => {
  it('answers a missing hashed asset with a 404, never the shell', async () => {
    const created = await fixture()

    const response = await created.app.request('/assets/app-1a2b3c4d.js')
    expect(response.status).toBe(404)
    // Not HTML: a browser parses this as JavaScript, and HTML is a syntax error there.
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('answers a missing file with an extension with a 404, whatever the client accepts', async () => {
    const created = await fixture()

    for (const [url, accept] of [
      ['/missing.css', '*/*'],
      ['/missing.png', 'image/*'],
      ['/assets/logo.svg', 'image/svg+xml'],
    ] as const) {
      const response = await created.app.request(url, { headers: { accept } })
      expect(response.status, `${url} (${accept})`).toBe(404)
      expect(await response.text(), `${url} (${accept})`).not.toContain('<title>stock</title>')
    }
  })

  it('still serves the shell for an extension-less client route', async () => {
    const created = await fixture()

    const response = await created.app.request('/w/default/servers/web')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('<title>stock</title>')
  })

  /**
   * The one judgement call the brief leaves open: a missing file **with** an extension that a
   * browser navigated to (`Accept: text/html`) is answered with the shell outside `/assets/`.
   *
   * Chosen because `Accept` is the browser saying "I am loading a page, not a subresource": a
   * script or stylesheet request never sends it (a stylesheet sends `text/css`, then a wildcard
   * with a low quality), so this cannot hide a missing asset — while a UI whose client-side route
   * happens to contain a dot still works on refresh. Inside `/assets/` there is no such reading
   * (the directory only holds build output), so that stays a 404 whatever `Accept` says.
   */
  it('serves the shell for an extensioned path navigated with Accept: text/html', async () => {
    const created = await fixture()

    for (const url of ['/legacy/panel.v2', '/w/default/servers/abc.def']) {
      const response = await created.app.request(url, { headers: { accept: 'text/html,application/xhtml+xml' } })
      expect(response.status, url).toBe(200)
      expect(response.headers.get('content-type'), url).toContain('text/html')
      expect(await response.text(), url).toContain('<title>stock</title>')
    }
  })

  it('keeps a missing subresource a 404 whatever its type', async () => {
    const created = await fixture()

    for (const [url, accept] of [
      ['/missing.css', 'text/css,*/*;q=0.1'],
      ['/missing.js', '*/*'],
      ['/assets/logo.svg', 'image/svg+xml,image/*;q=0.8'],
    ] as const) {
      const response = await created.app.request(url, { headers: { accept } })
      expect(response.status, `${url} (${accept})`).toBe(404)
      expect(response.headers.get('content-type'), url).toContain('application/json')
      expect(await response.text(), url).not.toContain('<title>stock</title>')
    }
  })

  it('keeps a missing hashed asset a 404 even when the request accepts text/html', async () => {
    const created = await fixture()

    const response = await created.app.request('/assets/index-CnBN54wF.js', { headers: { accept: 'text/html' } })
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('<title>stock</title>')
  })

  it('refuses a path outside the UI root, and does not hide it behind the shell', async () => {
    const created = await fixture()
    fs.writeFileSync(path.join(created.dir, 'secret.txt'), 'do-not-serve-me')

    // The control: the route does serve the UI, so "the secret was not served" cannot pass
    // because nothing is served at all.
    expect((await created.app.request('/')).status).toBe(200)

    // `/%2e%2e/secret.txt` never reaches the route as a traversal: WHATWG URL resolves the dot
    // segment, so it arrives as `/secret.txt` — a file with an extension that is not there, and
    // so a 404. The encoded slash in the other two is what reaches `resolveWithin`, which
    // refuses it. Either way the secret is unreachable; the two cases are asserted apart because
    // they are refused by different rules.
    for (const url of ['/%2e%2e/secret.txt', '/assets/%2e%2e%2f%2e%2e/secret.txt', '/..%2fsecret.txt']) {
      const response = await created.app.request(url, { headers: { accept: '*/*' } })
      expect(response.status, url).toBe(404)
      expect(await response.text(), url).not.toContain('do-not-serve-me')
    }

    // A page navigation to the same path cannot leak it either — it is answered by the shell,
    // which is what a 200 there means. Pinned so a change to the fallback cannot quietly serve
    // the file.
    const navigated = await created.app.request('/%2e%2e/secret.txt', { headers: { accept: 'text/html' } })
    expect(navigated.status).toBe(200)
    expect(await navigated.text()).not.toContain('do-not-serve-me')
  })

  it('keeps the JSON surfaces out of the shell', async () => {
    const created = await fixture()

    for (const url of ['/api/servres', '/_hh/nope', '/openapi/nope']) {
      const response = await created.app.request(url, { headers: { accept: 'text/html' } })
      expect(response.status, url).toBe(404)
      expect(response.headers.get('content-type'), url).toContain('application/json')
    }
  })
})
