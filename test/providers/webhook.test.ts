import type { AddressInfo } from 'node:net'
import http from 'node:http'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { sendWebhook } from '#src/providers/webhook'

describe('a webhook URL built from the environment', () => {
  it('never reports the expanded secret, only the placeholder', async () => {
    process.env.HH_TEST_HOOK_SECRET = 's3cr3t-value'
    try {
      const failing: typeof fetch = async () => {
        throw new TypeError(`Failed to parse URL from https://hooks.example.com/s3cr3t-value/x`)
      }
      // eslint-disable-next-line no-template-curly-in-string -- the literal placeholder is the point
      const target = { url: 'https://hooks.example.com/${HH_TEST_HOOK_SECRET}/x', method: 'POST' as const, format: 'json' as const, headers: '' }
      const outcome = await sendWebhook(target, { serverId: 'web', label: 'Web', reason: 'crash', detail: 'x' } as never, failing)
      expect(outcome.ok).toBe(false)
      expect(outcome.error).not.toContain('s3cr3t-value')
      // eslint-disable-next-line no-template-curly-in-string -- the literal placeholder is the point
      expect(outcome.error).toContain('${HH_TEST_HOOK_SECRET}')
    }
    finally {
      delete process.env.HH_TEST_HOOK_SECRET
    }
  })
})

/**
 * `fetch` follows redirects by default, which carried a target's own credential headers
 * (`X-Api-Key`) to whatever origin the receiver named — and allowed https to fall back to http.
 */
describe('a webhook receiver that redirects', () => {
  it('is not followed: the send fails naming the Location, and the credential stays home', async () => {
    const received: Array<string | undefined> = []
    const elsewhere = http.createServer((request, response) => {
      received.push(request.headers['x-api-key'] as string | undefined)
      response.end('ok')
    })
    await new Promise<void>(resolve => elsewhere.listen(0, '127.0.0.1', resolve))
    const elsewhereUrl = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/steal`
    const receiver = http.createServer((_request, response) => {
      response.writeHead(307, { location: elsewhereUrl })
      response.end()
    })
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
    try {
      const target = { url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`, method: 'POST' as const, format: 'json' as const, headers: 'X-Api-Key: hunter2' }
      const outcome = await sendWebhook(target, { serverId: 'web', label: 'Web', reason: 'crash', detail: 'x' } as never)
      expect(outcome.ok).toBe(false)
      expect(outcome.error).toContain('307')
      expect(outcome.error).toContain(elsewhereUrl)
      expect(received).toEqual([])
    }
    finally {
      receiver.close()
      elsewhere.close()
    }
  })
})
