import type { DdnsRecord } from '#src/providers/ddns/types'
import { describe, expect, it } from 'vitest'
import { wrote } from '#src/providers/ddns/types'

/**
 * Six adapters end their `update()` with `wrote(response, record)`, and nothing exercised a
 * failing write: breaking the helper to always succeed left the whole provider suite green.
 * The failure half is the one that matters — a non-ok response must not be reported as a
 * change, or the settings page says the hostname was updated when the registrar refused it.
 */
const record: DdnsRecord = { host: 'home.example.com', type: 'A', ip: '203.0.113.7', ttl: 300, proxied: false }

describe('wrote', () => {
  it('reports a failed write as a failure, with the provider body attached', async () => {
    const result = await wrote(new Response('{"message":"invalid key"}', { status: 403 }), record)

    expect(result.ok).toBe(false)
    expect(result.changed).toBe(false)
    expect(result.error).toContain('403')
    expect(result.error).toContain('invalid key')
  })

  it('names the record it changed on success', async () => {
    const result = await wrote(new Response('', { status: 200 }), record)

    expect(result).toEqual({ ok: true, changed: true, message: 'set home.example.com A to 203.0.113.7' })
  })

  it('still reports an HTTP status when the body is empty or unreadable', async () => {
    // `errorText` reads a body that may be absent; the status is the floor.
    expect((await wrote(new Response('', { status: 500 }), record)).error).toContain('500')
  })
})
