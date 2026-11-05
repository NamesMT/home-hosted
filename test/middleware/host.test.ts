import type { Fixture } from '../api/fixture'
import { afterEach, describe, expect, it } from 'vitest'
import { hostnameOf, isAllowedHost } from '#src/middleware/host'
import { jsonRequest, makeFixture } from '../api/fixture'

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
})

describe('the root app behind the host guard', () => {
  const fixtures: Fixture[] = []
  afterEach(async () => {
    for (const created of fixtures.splice(0)) await created.cleanup()
  })

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
})
