import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { probeHealth, probeHttp, probeTcp } from '#src/providers/health-check'

const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
})

async function httpServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<number> {
  const server = http.createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  servers.push({ close: () => new Promise<void>(resolve => server.close(() => resolve())) })
  return port
}

async function tcpServer(): Promise<number> {
  const server = net.createServer(socket => socket.end())
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  servers.push({ close: () => new Promise<void>(resolve => server.close(() => resolve())) })
  return port
}

const defaults = { path: '/', method: 'GET' as const, expectStatusBelow: 400, expectBody: '' }

describe('probeHttp', () => {
  it('passes on a 2xx and reports timing', async () => {
    const port = await httpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
    })

    const result = await probeHttp('127.0.0.1', port, { ...defaults, timeoutMs: 2000 })
    expect(result.healthy).toBe(true)
    expect(result.detail).toBe('HTTP 200')
    expect(result.ms).toBeGreaterThanOrEqual(0)
  })

  it('fails on a 5xx by default', async () => {
    const port = await httpServer((_req, res) => {
      res.writeHead(503)
      res.end('nope')
    })

    const result = await probeHttp('127.0.0.1', port, { ...defaults, timeoutMs: 2000 })
    expect(result.healthy).toBe(false)
    expect(result.detail).toContain('503')
  })

  it('treats a null expected status as "not set", so a cleared field works', async () => {
    const port = await httpServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })

    // `null` is what the settings API stores when the exact status is cleared.
    expect((await probeHttp('127.0.0.1', port, { ...defaults, expectStatus: null, timeoutMs: 2000 })).healthy).toBe(true)
  })

  it('honours an exact expected status', async () => {
    const port = await httpServer((_req, res) => {
      res.writeHead(302, { Location: '/' })
      res.end()
    })

    expect((await probeHttp('127.0.0.1', port, { ...defaults, expectStatus: 302, timeoutMs: 2000 })).healthy).toBe(true)
    expect((await probeHttp('127.0.0.1', port, { ...defaults, expectStatus: 200, timeoutMs: 2000 })).healthy).toBe(false)
  })

  it('checks a body substring when asked', async () => {
    const port = await httpServer((_req, res) => {
      res.writeHead(200)
      res.end('{"status":"ready"}')
    })

    expect((await probeHttp('127.0.0.1', port, { ...defaults, expectBody: '"status"', timeoutMs: 2000 })).healthy).toBe(true)
    const missing = await probeHttp('127.0.0.1', port, { ...defaults, expectBody: 'absent', timeoutMs: 2000 })
    expect(missing.healthy).toBe(false)
    expect(missing.detail).toContain('does not contain')
  })

  it('falls back to the status check on HEAD', async () => {
    const port = await httpServer((_req, res) => {
      res.writeHead(200)
      res.end('body')
    })

    const result = await probeHttp('127.0.0.1', port, { ...defaults, method: 'HEAD', expectBody: 'body', timeoutMs: 2000 })
    expect(result.healthy).toBe(true)
  })

  it('reports a refused connection', async () => {
    const result = await probeHttp('127.0.0.1', 9, { ...defaults, timeoutMs: 500 })
    expect(result.healthy).toBe(false)
    expect(result.detail).toContain('request failed')
  })
})

describe('probeTcp', () => {
  it('passes when something accepts and fails when nothing does', async () => {
    const port = await tcpServer()
    expect((await probeTcp('127.0.0.1', port, 500)).healthy).toBe(true)
    expect((await probeTcp('127.0.0.1', 9, 300)).healthy).toBe(false)
  })
})

describe('probeHealth', () => {
  it('uses the http check when configured', async () => {
    const port = await httpServer((_req, res) => {
      res.writeHead(200)
      res.end('ready')
    })

    const result = await probeHealth({
      mode: 'http',
      hosts: ['127.0.0.1'],
      port,
      timeoutMs: 2000,
      http: { ...defaults, expectBody: 'ready' },
    })
    expect(result.healthy).toBe(true)
  })

  it('tries each candidate host until one answers', async () => {
    const port = await tcpServer()
    const result = await probeHealth({
      mode: 'port',
      hosts: ['192.0.2.1', '127.0.0.1'],
      port,
      timeoutMs: 400,
      http: defaults,
    })
    expect(result.healthy).toBe(true)
  })

  it('reports the last failure when no host answers', async () => {
    const result = await probeHealth({
      mode: 'port',
      hosts: ['192.0.2.1', '127.0.0.1'],
      port: 9,
      timeoutMs: 300,
      http: defaults,
    })
    expect(result.healthy).toBe(false)
  })
})
