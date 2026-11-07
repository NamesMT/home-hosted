import type { Fixture } from '../api/fixture'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http2 from 'node:http2'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { serve } from 'srvx'
import { afterEach, describe, expect, it } from 'vitest'
import { errorHandler } from '#src/helpers/error'
import { createHostGuard, hostnameOf, isAllowedHost } from '#src/middleware/host'
import { jsonRequest, makeFixture } from '../api/fixture'
import { hasOpenssl } from '../support/capabilities'

describe('isAllowedHost', () => {
  it('allows what no remote site can rebind: IPs and local names', () => {
    for (const host of ['127.0.0.1:3999', '192.168.1.20', '[::1]:3999', '::1', 'localhost:3999', 'app.localhost', 'homeserver', 'nas.local', 'box.lan', 'pi.home.arpa'])
      expect(isAllowedHost(host, []), host).toBe(true)
  })

  it('refuses a public name nobody declared', () => {
    expect(isAllowedHost('evil.example.com:3999', [])).toBe(false)
    expect(isAllowedHost('rebind.attacker.io', ['panel.example.com'])).toBe(false)
  })

  it('allows a declared name, and a wildcard only for its subdomains', () => {
    expect(isAllowedHost('Panel.Example.com:443', ['panel.example.com'])).toBe(true)
    expect(isAllowedHost('a.example.com', ['*.example.com'])).toBe(true)
    expect(isAllowedHost('example.com', ['*.example.com'])).toBe(false)
    expect(isAllowedHost('notexample.com', ['*.example.com'])).toBe(false)
  })

  it('reads the hostname out of every Host spelling', () => {
    expect(hostnameOf('Example.COM:8080')).toBe('example.com')
    expect(hostnameOf('[fe80::1]:3999')).toBe('fe80::1')
    expect(hostnameOf('example.com.')).toBe('example.com')
  })

  /**
   * A request naming no host is refused rather than waved through.
   *
   * This branch used to answer `true`, which is what turned "HTTP/2 has no `Host` header" into an open
   * door: the guard returned "allowed" without having seen a name at all. Answering a *missing* name
   * is not the same as answering an *allowed* one.
   */
  it('refuses a request that names no host at all', () => {
    expect(isAllowedHost(undefined, [])).toBe(false)
    expect(isAllowedHost('', [])).toBe(false)
    expect(isAllowedHost('   ', [])).toBe(false)
  })
})

describe('the root app behind the host guard', () => {
  const fixtures: Fixture[] = []
  const scratch: string[] = []
  afterEach(async () => {
    for (const created of fixtures.splice(0)) await created.cleanup()
    for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A scratch directory for a self-signed pair, swept with the fixtures. */
  function certDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-host-cert-'))
    scratch.push(dir)
    return dir
  }

  it('refuses a DNS-rebound page before it can log in', async () => {
    const created = await makeFixture({ password: 'a-good-password', ip: '127.0.0.1' })
    fixtures.push(created)
    const rebound = await created.app.request('http://evil.example.com:3999/api/auth/login', {
      ...jsonRequest('POST', { password: 'a-good-password' }),
      headers: { 'content-type': 'application/json', 'host': 'evil.example.com:3999', 'origin': 'http://evil.example.com:3999' },
    })
    expect(rebound.status).toBe(421)
    expect(await rebound.json()).toMatchObject({ code: 'HOST_NOT_ALLOWED' })

    const local = await created.app.request('http://127.0.0.1:3999/api/auth/login', {
      ...jsonRequest('POST', { password: 'a-good-password' }),
      headers: { 'content-type': 'application/json', 'host': '127.0.0.1:3999' },
    })
    expect(local.status).toBe(200)
  })

  it('answers a public name once it is declared in control.allowedHosts', async () => {
    const created = await makeFixture({ ip: '127.0.0.1' })
    fixtures.push(created)
    created.settings.updateControl({ allowedHosts: ['panel.example.com'] })
    const response = await created.app.request('http://panel.example.com/healthz', { headers: { host: 'panel.example.com' } })
    expect(response.status).toBe(200)
  })

  /**
   * The guard must read the name the request actually carried, and HTTP/2 carries it in `:authority`
   * rather than `Host`. srvx serves TLS through `nodeHTTP2` (with `allowHTTP1`), so every HTTPS panel
   * answers h2 — and a guard reading only `Host` answered "allowed" for a name it never saw.
   *
   * Driven through a real TLS listener on purpose: `app.request()` cannot express a pseudo-header, so
   * the tests above stayed green while the guard was open.
   */
  it.runIf(hasOpenssl)('refuses a rebound name sent as :authority, and answers the real one', async () => {
    const dir = certDir()
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' })
    const guarded = new Hono()
      .onError(errorHandler)
      .use('*', createHostGuard(() => []))
      .get('/healthz', c => c.json({ status: 'ok' }))
    const server = serve({
      fetch: guarded.fetch,
      port: 0,
      hostname: '127.0.0.1',
      tls: { cert: fs.readFileSync(path.join(dir, 'c.pem'), 'utf8'), key: fs.readFileSync(path.join(dir, 'k.pem'), 'utf8') },
    })
    await server.ready()
    const port = new URL(server.url!).port

    const ask = (authority: string): Promise<number> => new Promise((resolve, reject) => {
      const client = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false })
      const request = client.request({ ':path': '/healthz', ':method': 'GET', ':authority': authority })
      request.on('response', (headers) => {
        resolve(Number(headers[':status']))
        // `destroy()`, not `close()`: a half-closed h2 session keeps the listener's close() waiting.
        client.destroy()
      })
      request.on('error', reject)
      request.end()
    })

    expect(await ask('evil.example.com'), 'a rebound name must not reach a route').toBe(421)
    expect(await ask('127.0.0.1'), 'the real listener still answers').toBe(200)
    await server.close()
  })
})
