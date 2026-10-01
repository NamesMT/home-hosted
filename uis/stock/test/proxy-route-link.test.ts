import { describe, expect, it } from 'vitest'
import { retryInLabel, routeUrl } from '../src/lib/proxy'

/** Only the three fields the link reads. */
function route(over: { host?: string, path?: string, tls?: string } = {}) {
  return { host: 'git.example.com', path: '', tls: 'auto', ...over } as Parameters<typeof routeUrl>[0]
}

describe('the route link', () => {
  it('points at the configured port, and leaves a standard one out', () => {
    expect(routeUrl(route(), 80, 4443)).toBe('https://git.example.com:4443')
    expect(routeUrl(route(), 80, 443)).toBe('https://git.example.com')
  })

  it('uses the plain port for a route that is not on TLS', () => {
    expect(routeUrl(route({ tls: 'off' }), 8080, 4443)).toBe('http://git.example.com:8080')
    expect(routeUrl(route({ tls: 'off' }), 80, 4443)).toBe('http://git.example.com')
  })

  it('keeps the path, so the link is not the page that says the route is unconfigured', () => {
    expect(routeUrl(route({ path: '/app' }), 80, 4443)).toBe('https://git.example.com:4443/app')
    expect(routeUrl(route({ path: 'app' }), 80, 4443)).toBe('https://git.example.com:4443/app')
  })

  it('has no link while the hostname is still empty', () => {
    expect(routeUrl(route({ host: '   ' }), 80, 4443)).toBeNull()
  })
})

describe('the retry interval label', () => {
  it('reads inside "every ...", so it carries no preposition of its own', () => {
    expect(retryInLabel(480)).toBe('~8 hours')
    expect(retryInLabel(40)).toBe('~40 minutes')
    expect(retryInLabel(60)).toBe('~1 hour')
    expect(retryInLabel(1)).toBe('~1 minute')
  })

  it('falls back to the engine default when an older panel sends no interval', () => {
    expect(retryInLabel(null)).toBe('~8 hours')
  })
})
