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

  /**
   * The rest of the forwarding family counts too, and that is a deliberate tightening.
   *
   * A minimal nginx config very often forwards **only** `X-Forwarded-Proto` (the usual way to tell an
   * app its visitor arrived over https) or rewrites `Host`/the port. Those requests carry no address
   * header, so under the old three-name list a loopback peer behind such a proxy read as "this
   * machine" and the internet got the local trust that grants — the first-password path, `/_hh`, and
   * `/api` with no credential while no password is in force.
   *
   * This is defence in depth, not a guarantee: an `isLoopbackRequest` cannot distinguish the panel's
   * own engine from a misconfigured proxy, and one that strips every one of these headers still reads
   * as local. docs/SECURITY.md states the rule as the heuristic it is. Pinned per header so dropping
   * one from the list is a failing test rather than a quiet reopening.
   */
  it('does not trust a loopback peer behind a proxy that forwards only the non-address headers', () => {
    for (const header of ['x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-prefix']) {
      expect(isLoopbackRequest(request('127.0.0.1', { [header]: 'https' })), header).toBe(false)
      // On the IPv6 loopback too: the peer check and the header check are independent halves.
      expect(isLoopbackRequest(request('::1', { [header]: 'https' })), header).toBe(false)
    }
  })

  it('never trusts a remote or unknown peer', () => {
    expect(isLoopbackRequest(request('192.168.1.10'))).toBe(false)
    expect(isLoopbackRequest(request(undefined))).toBe(false)
  })
})
