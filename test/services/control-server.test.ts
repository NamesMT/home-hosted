import type { Bind } from '#src/shared/contracts'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ControlServer } from '#src/services/control-server'

/**
 * The panel's own listener. Moving it is the one operation that can make the panel
 * unreachable, so the interesting cases are the refusal and the rollback, not the
 * happy path.
 */

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Binds port 0 so the OS picks, then waits for the port to be genuinely free again. */
async function freePort(): Promise<number> {
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo
      server.close(() => resolve(address.port))
    })
  })
  // A just-closed listener can still complete a handshake for a moment.
  await new Promise(resolve => setTimeout(resolve, 150))
  return port
}

interface Probe {
  status: number
  body: string
}

/** Talks to the listener the way a client would; a refused connection is a probe result, not a throw. */
function get(url: string): Promise<Probe | null> {
  return new Promise((resolve) => {
    const secure = url.startsWith('https:')
    const request = (secure ? https : http).request(url, { method: 'GET', ...(secure ? { rejectUnauthorized: false } : {}) }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
      })
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    request.once('error', () => resolve(null))
    request.end()
  })
}

function tracked(server: ControlServer): ControlServer {
  cleanups.push(async () => {
    await server.close()
  })
  return server
}

describe('control server', () => {
  it('binds, serves and reports the endpoint it actually bound', async () => {
    const port = await freePort()
    const server = tracked(new ControlServer({
      fetch: () => new Response('panel', { status: 200 }),
      trustProxy: () => false,
      tls: () => null,
    }, { host: 'local', port }))

    await server.start()

    expect(server.liveHost).toBe('local')
    expect(server.livePort).toBe(port)
    expect(server.endpoint.bindHost).toBe('127.0.0.1')
    expect(server.endpoint.protocol).toBe('http')
    expect(server.endpoint.url).toBe(`http://127.0.0.1:${port}`)

    const probe = await get(`http://127.0.0.1:${port}/healthz`)
    expect(probe).toMatchObject({ status: 200, body: 'panel' })
  })

  it('reads the trustProxy and tls thunks on every (re)bind, not once', async () => {
    const port = await freePort()
    let trustProxy = 0
    let tlsReads = 0
    const server = tracked(new ControlServer({
      fetch: () => new Response('ok'),
      trustProxy: () => {
        trustProxy += 1
        return false
      },
      tls: () => {
        tlsReads += 1
        return null
      },
    }, { host: 'local', port }))

    await server.start()
    expect([trustProxy, tlsReads]).toEqual([1, 1])

    // A settings change must apply without a restart of the panel process.
    await server.restart()
    expect([trustProxy, tlsReads]).toEqual([2, 2])
  })

  it('rebinds to a new port and serves there', async () => {
    const first = await freePort()
    const second = await freePort()
    const server = tracked(new ControlServer({
      fetch: () => new Response('moved'),
      trustProxy: () => false,
      tls: () => null,
    }, { host: 'local', port: first }))

    await server.start()
    expect(await server.rebind({ host: 'local', port: second })).toEqual({ ok: true })

    expect(server.livePort).toBe(second)
    expect(await get(`http://127.0.0.1:${second}/`)).toMatchObject({ body: 'moved' })
    // The old listener is gone rather than lingering.
    expect(await get(`http://127.0.0.1:${first}/`)).toBeNull()
  })

  it('refuses a port somebody else holds, without disturbing the listener it has', async () => {
    const mine = await freePort()
    const server = tracked(new ControlServer({
      fetch: () => new Response('still here'),
      trustProxy: () => false,
      tls: () => null,
    }, { host: 'local', port: mine }))
    await server.start()

    const squatter = net.createServer()
    cleanups.push(async () => {
      await new Promise<void>(resolve => squatter.close(() => resolve()))
    })
    const taken = await new Promise<number>((resolve, reject) => {
      squatter.once('error', reject)
      squatter.listen(0, '127.0.0.1', () => resolve((squatter.address() as net.AddressInfo).port))
    })

    const result = await server.rebind({ host: 'local', port: taken })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('already in use')

    // A refused move must leave the panel exactly where it was.
    expect(server.livePort).toBe(mine)
    expect(await get(`http://127.0.0.1:${mine}/`)).toMatchObject({ body: 'still here' })
  })

  it('falls back to the previous endpoint when the new one refuses to bind', async () => {
    const port = await freePort()
    const server = tracked(new ControlServer({
      fetch: () => new Response('recovered'),
      trustProxy: () => false,
      tls: () => null,
    }, { host: 'local', port }))
    await server.start()

    // Changing only the host skips the port preflight, so this reaches the listen
    // itself — and TEST-NET-3 is not an address this machine can bind.
    const result = await server.rebind({ host: '203.0.113.9' as Bind, port })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('rebind failed')
    expect(server.liveHost).toBe('local')
    expect(await get(`http://127.0.0.1:${port}/`)).toMatchObject({ body: 'recovered' })
  })

  it('is a no-op when asked to move where it already is', async () => {
    const port = await freePort()
    const server = tracked(new ControlServer({
      fetch: () => new Response('same'),
      trustProxy: () => false,
      tls: () => null,
    }, { host: 'local', port }))
    await server.start()

    expect(await server.rebind({ host: 'local', port })).toEqual({ ok: true })
    expect(await get(`http://127.0.0.1:${port}/`)).toMatchObject({ body: 'same' })
  })

  it('closes idempotently, including before it ever listened', async () => {
    const port = await freePort()
    const server = new ControlServer({
      fetch: () => new Response('x'),
      trustProxy: () => false,
      tls: () => null,
    }, { host: 'local', port })

    await expect(server.close()).resolves.toBeUndefined()

    await server.start()
    await server.close()
    await server.close()
    expect(await get(`http://127.0.0.1:${port}/`)).toBeNull()
  })

  it('reports a restart failure instead of throwing at the settings route', async () => {
    const port = await freePort()
    const server = tracked(new ControlServer({
      fetch: () => new Response('x'),
      trustProxy: () => false,
      tls: () => null,
    }, { host: 'local', port }))
    await server.start()

    // Steal the port while nobody is listening on it, then ask for a restart.
    const squatter = net.createServer()
    cleanups.push(async () => {
      await new Promise<void>(resolve => squatter.close(() => resolve()))
    })
    await server.close()
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject)
      squatter.listen(port, '127.0.0.1', () => resolve())
    })

    const result = await server.restart()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('restart failed')
  })
})

describe('control server over TLS', () => {
  let cert = ''
  let key = ''
  let openssl = true

  beforeAll(async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-control-tls-'))
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '3', '-subj', '/CN=hh.test'], { stdio: 'ignore' })
      cert = await fs.promises.readFile(path.join(dir, 'cert.pem'), 'utf8')
      key = await fs.promises.readFile(path.join(dir, 'key.pem'), 'utf8')
    }
    catch {
      openssl = false
    }
    finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  })

  it('serves https and reflects the scheme in the endpoint', async () => {
    if (!openssl)
      return

    const port = await freePort()
    const server = tracked(new ControlServer({
      fetch: () => new Response('secure'),
      trustProxy: () => false,
      tls: () => ({ cert, key }),
    }, { host: 'local', port, tls: true }))

    await server.start()

    expect(server.endpoint.protocol).toBe('https')
    expect(server.endpoint.url).toBe(`https://127.0.0.1:${port}`)
    expect(await get(`https://127.0.0.1:${port}/`)).toMatchObject({ status: 200, body: 'secure' })
  })
})
