import type { Fixture } from './fixture'
import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFixture, makeView } from './fixture'

const fixtures: Fixture[] = []

afterEach(async () => {
  for (const created of fixtures.splice(0).reverse()) await created.cleanup()
})

/**
 * The upload guards read `Content-Length` with `Number.parseInt`, which looks like the prefix bug
 * fixed in the CLI twice — and a future reader would reasonably "fix" it. It is not: this value is
 * a header Node has already validated, so the only shapes that reach a handler are decimal, and a
 * partial parse cannot make an oversized upload pass. The body is measured afterwards anyway, so
 * the header check is a pre-flight optimisation with the authoritative check behind it.
 *
 * This pins the assumption rather than the code: if a future Node stopped validating the header,
 * the guards would need a real parse and this test would be the thing that says so.
 */
describe('a non-decimal Content-Length never reaches a handler', () => {
  it('is refused by the HTTP parser before routing', async () => {
    const created = await makeFixture({ views: [makeView('web')] })
    fixtures.push(created)

    // Drive the app through a real socket: `app.request` bypasses the HTTP parser entirely, so it
    // cannot answer this question.
    const server = http.createServer(async (req, res) => {
      const response = await created.app.request(req.url ?? '/', { method: req.method })
      res.writeHead(response.status)
      res.end(await response.text())
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    const send = async (header: string): Promise<string> => {
      return await new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write(`POST /api/backups/import HTTP/1.1\r\nHost: localhost\r\nContent-Type: multipart/form-data\r\nContent-Length: ${header}\r\n\r\n`)
        })
        let data = ''
        socket.on('data', (chunk) => { data += chunk.toString() })
        socket.on('end', () => resolve(data.split('\r\n')[0] ?? ''))
        socket.on('error', reject)
        setTimeout(() => {
          socket.destroy()
          resolve(data.split('\r\n')[0] ?? '')
        }, 1500)
      })
    }

    try {
      // A non-decimal length is a protocol error, answered before any handler sees it.
      expect(await send('1e12')).toContain('400')
      expect(await send('0x20000001')).toContain('400')
      // A real number gets through to the app (401 here: no credentials on a raw socket).
      expect(await send('10')).not.toContain('400')
    }
    finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
