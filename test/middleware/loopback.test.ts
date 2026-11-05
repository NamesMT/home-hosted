import { describe, expect, it } from 'vitest'
import { isLoopbackRequest } from '#src/middleware/loopback'

function request(ip: string | undefined, headers: Record<string, string> = {}) {
  const raw = Object.assign(new Request('http://127.0.0.1:3999/', { headers }), { ip })
  return { req: { raw } }
}

describe('isLoopbackRequest', () => {
  it('trusts a direct loopback peer', () => {
    expect(isLoopbackRequest(request('127.0.0.1'))).toBe(true)
    expect(isLoopbackRequest(request('::1'))).toBe(true)
  })

  it('does not trust a loopback peer that relayed someone else', () => {
    // The panel's own reverse proxy connects from 127.0.0.1 on behalf of an internet client.
    for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip'])
      expect(isLoopbackRequest(request('127.0.0.1', { [header]: '203.0.113.9' })), header).toBe(false)
  })

  it('never trusts a remote or unknown peer', () => {
    expect(isLoopbackRequest(request('192.168.1.10'))).toBe(false)
    expect(isLoopbackRequest(request(undefined))).toBe(false)
  })
})
