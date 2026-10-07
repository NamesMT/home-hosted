import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserServerUrl, isLoopbackHost, pageHostname } from '#src/shared/server-url'

/**
 * The link a viewer can actually reach.
 *
 * A `lan` entry is reported at this machine's LAN address, which is unroutable for anyone arriving
 * over a public hostname or a tunnel — the exact users the bind was opened for. The panel cannot see
 * the browser's name, so the swap is made client-side and shared, and the cases it must *not* touch
 * are what these pin: a loopback entry, a specific-IP entry, and a viewer already on this machine.
 */

/** An entry that listens on every interface, reported at its LAN address. */
function lan(overrides: Partial<{ url: string | null, bindHost: string }> = {}) {
  return { url: 'http://192.168.1.20:4991', bindHost: '0.0.0.0', ...overrides }
}

describe('isLoopbackHost', () => {
  it('recognizes every name that resolves to this machine', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.0.0.53', '::1', '[::1]', 'panel.localhost', ' localhost '])
      expect(isLoopbackHost(host), host).toBe(true)
  })

  it('leaves a reachable name alone', () => {
    // A `.local` mDNS name is not loopback: it can resolve elsewhere, and an empty host is a
    // missing location rather than this machine.
    for (const host of ['evox1.isthe.top', '192.168.1.20', 'box.local', '10.0.0.5', ''])
      expect(isLoopbackHost(host), host).toBe(false)
  })
})

describe('browserServerUrl', () => {
  it('uses the page hostname when the entry listens on every interface', () => {
    expect(browserServerUrl(lan(), 'evox1.isthe.top')).toBe('http://evox1.isthe.top:4991')
  })

  it('keeps the entry’s own port, not the panel’s', () => {
    // The panel is on 4999 here; 4991 is the server's port and the only one it answers on.
    expect(browserServerUrl(lan(), 'evox1.isthe.top')).toContain(':4991')
  })

  it('keeps a specific-IP entry, which the page hostname cannot reach', () => {
    const specific = { url: 'http://10.0.0.5:8080', bindHost: '10.0.0.5' }
    expect(browserServerUrl(specific, 'evox1.isthe.top')).toBe('http://10.0.0.5:8080')
  })

  it('keeps a loopback entry, which nothing outside the machine reaches', () => {
    const local = { url: 'http://127.0.0.1:3000', bindHost: '127.0.0.1' }
    // Rewriting this would point at the panel with the server's port — a worse link than the honest one.
    expect(browserServerUrl(local, 'evox1.isthe.top')).toBe('http://127.0.0.1:3000')
  })

  it('keeps the LAN address when the viewer is already on this machine', () => {
    for (const host of ['localhost', '127.0.0.1', '::1'])
      expect(browserServerUrl(lan(), host), host).toBe('http://192.168.1.20:4991')
  })

  it('keeps the LAN address when there is no page host to read', () => {
    // An empty host is "cannot tell", not "local": rewriting it would build `http://:4991`.
    expect(browserServerUrl(lan(), '')).toBe('http://192.168.1.20:4991')
  })

  it('returns null without a port, so the link stays absent', () => {
    expect(browserServerUrl(lan({ url: null }), 'evox1.isthe.top')).toBeNull()
  })

  it('carries a path, query and fragment across', () => {
    expect(browserServerUrl(lan({ url: 'http://192.168.1.20:4991/app?x=1#top' }), 'box.example'))
      .toBe('http://box.example:4991/app?x=1#top')
  })

  it('drops the trailing slash `URL` adds, so the link matches what the panel reported', () => {
    // `new URL('http://host:4991').pathname` is `/`; keeping it would render `http://host:4991/`
    // where every other link reads `http://host:4991`.
    expect(browserServerUrl(lan(), 'box.example')).toBe('http://box.example:4991')
  })

  it('brackets an IPv6 page host', () => {
    expect(browserServerUrl(lan(), 'fe80::1')).toBe('http://[fe80::1]:4991')
  })

  it('leaves an already-bracketed IPv6 page host alone', () => {
    // `location.hostname` brackets it, so a second pair would produce `[[fe80::1]]`.
    expect(browserServerUrl(lan(), '[fe80::1]')).toBe('http://[fe80::1]:4991')
  })

  it('adds no port when the reported url carries none', () => {
    // A hand-written frame can omit it, and `URL` drops a default one (`:80` on http has
    // `port === ''`). Either way the authority must not gain a bare colon.
    expect(browserServerUrl(lan({ url: 'http://192.168.1.20/x' }), 'box.example')).toBe('http://box.example/x')
    expect(browserServerUrl(lan({ url: 'http://192.168.1.20:80/x' }), 'box.example')).toBe('http://box.example/x')
  })

  it('returns an unparseable url unchanged rather than dropping the link', () => {
    const broken = { url: 'not a url', bindHost: '0.0.0.0' }
    expect(browserServerUrl(broken, 'box.example')).toBe('not a url')
  })
})

describe('pageHostname', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the browser location when there is one', () => {
    // This suite is not the DOM environment, so the location is supplied directly.
    vi.stubGlobal('location', { hostname: 'evox1.isthe.top' })
    expect(pageHostname()).toBe('evox1.isthe.top')
  })

  it('answers an empty string where there is no location', () => {
    // Node and any non-DOM run must not throw; an empty host reads as "cannot tell".
    vi.stubGlobal('location', undefined)
    expect(pageHostname()).toBe('')
  })
})
