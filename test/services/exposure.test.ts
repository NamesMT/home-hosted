import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { checkExposure, checkProxyExposure, dialsPanel, proxyTrustWarning } from '#src/services/exposure'
import { authSchema, controlSchema, proxyConfigSchema } from '#src/shared/contracts'

function control(host: string, auth: Record<string, unknown> = {}) {
  const parsed = controlSchema({ host, auth })
  if (parsed instanceof type.errors)
    throw parsed
  return parsed
}

function proxy(input: Record<string, unknown>) {
  const parsed = proxyConfigSchema(input)
  if (parsed instanceof type.errors)
    throw parsed
  return parsed
}

describe('control panel exposure', () => {
  it('treats loopback as safe, whatever the auth state', () => {
    for (const passwordSet of [true, false]) {
      const state = checkExposure(control('local'), passwordSet)
      expect(state.exposed).toBe(false)
      expect(state.blockedReason).toBeNull()
    }
  })

  it('blocks every non-loopback bind that lacks a password', () => {
    for (const host of ['lan', '0.0.0.0', '192.168.1.10']) {
      for (const auth of [{}, { enabled: true }, { enabled: false }]) {
        const state = checkExposure(control(host, auth), false)
        expect(state.exposed, host).toBe(true)
        expect(state.blockedReason, `${host} ${JSON.stringify(auth)}`).not.toBeNull()
      }
    }
  })

  it('blocks a non-loopback bind with a password when auth is switched off', () => {
    const state = checkExposure(control('lan', { enabled: false }), true)
    expect(state.exposed).toBe(true)
    expect(state.blockedReason).toContain('disabled')
  })

  it('allows a non-loopback bind when auth is on and armed', () => {
    const state = checkExposure(control('lan', { enabled: true }), true)
    expect(state).toEqual({ exposed: true, blockedReason: null })
  })

  /**
   * The third argument was never passed by any test in this file, so this branch — `defaults to false`
   * — was never taken. It is the strictest case: a bind beyond loopback with auth armed and a password
   * set is allowed, and must be refused while that password is still the boot one.
   */
  it('refuses an exposed bind while the password is still the default', () => {
    const state = checkExposure(control('lan', { enabled: true }), true, true)
    expect(state.exposed).toBe(true)
    // Asserted against `null` first: `.toContain` on a null reason reports a vitest argument error
    // rather than the property that failed.
    expect(state.blockedReason, 'an armed panel on the boot password is still a way in').not.toBeNull()
    expect(state.blockedReason!).toContain('default password')

    // And it does not fire where the other two guards would, so the ordering is real.
    expect(checkExposure(control('local'), true, true).blockedReason).toBeNull()
    const noPassword = checkExposure(control('lan', { enabled: true }), false, true).blockedReason
    expect(noPassword).not.toBeNull()
    expect(noPassword!).toContain('no password')
  })

  it('names the missing piece in the reason', () => {
    expect(checkExposure(control('lan', { enabled: true }), false).blockedReason).toContain('no password')
    expect(checkExposure(control('lan', { enabled: false }), false).blockedReason).toContain('authentication is disabled')
  })

  /**
   * The sentence a person reads on their own settings page tells them what to do, so it has to name
   * a command that exists. It said `pnpm run set-password`, which is this *repository's* shorthand:
   * `pnpm run set-password` answers `ERR_PNPM_NO_SCRIPT` (measured), and a person who installed the
   * package has no such script at all — the bin is `home-hosted`, with `hh` as its alias.
   */
  it('tells the person a command that exists', () => {
    const reason = checkExposure(control('lan', { enabled: true }), false).blockedReason!
    expect(reason).toContain('home-hosted set-password')
    expect(reason, 'a repository script is not a command a user has').not.toContain('pnpm run')
  })

  it('defaults to a local bind with authentication on', () => {
    const parsed = controlSchema({})
    expect(parsed instanceof type.errors).toBe(false)
    if (parsed instanceof type.errors)
      return
    expect(parsed.host).toBe('local')
    expect(parsed.auth.enabled).toBe(true)
    expect(parsed.auth.sessionTtlMs).toBe(604800000)
    expect(parsed.tls.enabled).toBe(false)
  })

  it('blocks exposure while the default password is still in use', () => {
    const state = checkExposure(control('lan', { enabled: true }), true, true)
    expect(state.exposed).toBe(true)
    expect(state.blockedReason).toContain('default password')
  })

  it('rejects unknown auth keys', () => {
    expect(authSchema({ enabled: true, typo: 1 } as unknown) instanceof type.errors).toBe(true)
  })
})

describe('trusting a proxy on an exposed bind', () => {
  /**
   * The combination that makes the login lockout advisory.
   *
   * `trustProxy: true` trusts `x-forwarded-*` from any peer, and srvx resolves the client address from
   * the caller's own `x-forwarded-for`. Failures are keyed on that address, so rotating the header
   * never accumulates them — measured, 30 wrong passwords from 30 forged addresses gave **zero** 429s
   * against 27 from a fixed one. Warned rather than refused: a remote proxy is a real setup, and the
   * true peer is not reachable through srvx once the header is trusted.
   */
  it('warns only for the exposed combination', () => {
    const trusted = (host: string): string | null =>
      proxyTrustWarning(control(host, { enabled: true, trustProxy: true }))

    expect(trusted('lan'), 'the exposed case').toContain('x-forwarded-for')
    expect(trusted('0.0.0.0')).not.toBeNull()
    // A loopback bind is the fix, so it must not warn.
    expect(trusted('local'), 'loopback is the remedy').toBeNull()
    // And trustProxy off is the other fix.
    expect(proxyTrustWarning(control('lan', { enabled: true, trustProxy: false }))).toBeNull()

    /*
     * `'loopback'` is the third answer, and the one the warning itself recommends — "keep the bind on
     * local with the proxy on this machine". It trusts `x-forwarded-*` only when the peer *is* loopback,
     * so a forged header from anywhere else is ignored and the lockout keeps counting per real address.
     * Measured against a real srvx server from a non-loopback peer: `'loopback'` reported the true peer
     * `192.168.1.201` while `true` reported the forged `8.8.8.8`.
     */
    expect(proxyTrustWarning(control('lan', { enabled: true, trustProxy: 'loopback' }))).toBeNull()
    expect(proxyTrustWarning(control('0.0.0.0', { enabled: true, trustProxy: 'loopback' }))).toBeNull()
  })
})

describe('reverse proxy exposure', () => {
  const panelRoute = { id: 'panel', host: 'panel.example.com', target: 'panel' as const }

  it('says nothing about a proxy that is off, or that serves no panel route', () => {
    expect(checkProxyExposure(proxy({ enabled: false, routes: [panelRoute] }), false, false)).toBeNull()
    expect(checkProxyExposure(proxy({ enabled: true, routes: [{ id: 'git', host: 'git.example.com', target: 'external', url: 'http://10.0.0.5:3000' }] }), false, false)).toBeNull()
  })

  it('holds a panel route to the same bar as a non-loopback bind', () => {
    const on = proxy({ enabled: true, routes: [panelRoute] })
    expect(checkProxyExposure(on, true, true, false)).toBeNull()
    expect(checkProxyExposure(on, false, false)).toContain('authentication is disabled and no password is set')
    expect(checkProxyExposure(on, false, true)).toContain('authentication is disabled')
    expect(checkProxyExposure(on, true, false)).toContain('no password is set')
    expect(checkProxyExposure(on, true, true, true)).toContain('default password')
    // The hostname is named, so the message points at the route to change.
    expect(checkProxyExposure(on, true, false)).toContain('panel.example.com')
  })

  it('ignores a disabled route, but not one that merely serves plain HTTP', () => {
    const disabled = proxy({ enabled: true, routes: [{ ...panelRoute, enabled: false }] })
    expect(checkProxyExposure(disabled, false, false)).toBeNull()

    // `tls: "off"` used to be skipped here, which was backwards. The engine upstreams a panel route
    // to `127.0.0.1`, the `/api` guard reads a loopback request as local while auth is enabled but
    // unarmed, so a plain-HTTP panel route with no password set served the panel to anyone who
    // reached that hostname — the same exposure as an `auto` one, in the clear. The bar is about who
    // can reach the panel, not about whether the hop is encrypted.
    const plain = proxy({ enabled: true, routes: [{ ...panelRoute, tls: 'off' }] })
    expect(checkProxyExposure(plain, false, false)).toContain('authentication is disabled and no password is set')
    expect(checkProxyExposure(plain, true, true, false)).toBeNull()
    expect(checkProxyExposure(plain, true, false)).toContain('no password is set')
  })

  /**
   * An `external` route whose upstream is the panel's own listener serves the panel just as a
   * `target: "panel"` route does — it was not counted, so it slipped past the rule entirely.
   */
  it('counts an external route dialing the panel listener as a panel route', () => {
    for (const url of ['http://127.0.0.1:6123', '127.0.0.1:6123', 'http://localhost:6123', 'http://[::1]:6123', 'http://0.0.0.0:6123', 'http://127.1:6123', 'https://localhost.:6123', 'http://[::ffff:127.0.0.1]:6123']) {
      const on = proxy({ enabled: true, routes: [{ id: 'sneaky', host: 'panel.lan', target: 'external', url }] })
      expect(checkProxyExposure(on, true, false, false, [6123]), url).toContain('no password is set')
      expect(checkProxyExposure(on, true, true, false, [6123]), url).toBeNull()
    }
    // Another port, or another machine, is an ordinary upstream.
    expect(dialsPanel('http://127.0.0.1:6124', [6123])).toBe(false)
    expect(dialsPanel('http://10.0.0.5:6123', [6123])).toBe(false)
    expect(dialsPanel('http://localhost', [80])).toBe(true)
    expect(dialsPanel('ftp://localhost:6123', [6123])).toBe(false)
  })
})
