import { type } from 'arktype'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkExposure, checkProxyExposure, dialsPanel, primeUpstreamResolutions, proxyTrustWarning, setUpstreamResolver } from '#src/services/exposure'
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
    expect(state.blockedReason!).toContain('first-run password')

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
    expect(reason).toMatch(/`home-hosted( --home \S+)? set-password`/)
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
    expect(state.blockedReason).toContain('first-run password')
  })

  /**
   * A one-character password used to be enough to put the panel on the LAN: the schema floor is 1,
   * and the exposure rule only asked whether *a* password was set.
   */
  it('refuses an exposed bind behind a password shorter than 12 characters', () => {
    const state = checkExposure(control('lan', { enabled: true }), true, false, true)
    expect(state.exposed).toBe(true)
    expect(state.blockedReason).not.toBeNull()
    expect(state.blockedReason!).toContain('shorter than 12 characters')
    expect(state.blockedReason!).toContain('set-password')
    // On loopback any length is fine.
    expect(checkExposure(control('local'), true, false, true).blockedReason).toBeNull()
  })

  it('names the fix for the first-run password in one sentence', () => {
    const reason = checkExposure(control('lan', { enabled: true }), true, true).blockedReason!
    expect(reason).toMatch(/^can't listen on lan while the panel still has its first-run password — run `.+ set-password` or change it in Global settings → Authentication$/)
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
    expect(checkProxyExposure(on, true, true, true)).toContain('first-run password')
    expect(checkProxyExposure(on, true, true, false, [], true)).toContain('shorter than 12 characters')
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

/**
 * A route points at the panel when its **destination** is loopback, not when it is *spelled* loopback.
 *
 * The measured bypass: `http://panel.attacker.example:3999` with an A record of `127.0.0.1` (or
 * `127.0.0.1.nip.io`) was an ordinary `external` route. `checkProxyExposure` saw no panel route,
 * `reconcile()` published it, and the engine then dialled the panel from `127.0.0.1` **with no
 * forwarding headers** — which is exactly what `isLoopbackRequest` reads as "this machine", so with
 * auth enabled but no password set the panel served `/api` anonymously to whoever reached that name.
 *
 * The rule chosen, and why it is the right one: the question is "where does this go", so a hostname
 * whose resolution includes a loopback address is a panel route — and a hostname that does not
 * resolve **also** counts, because the two mistakes are not symmetric. Publishing a route that turns
 * out to dial the panel hands the internet the whole panel; refusing a route the person meant to add
 * is one retry once DNS is back. Fail closed.
 */
describe('an upstream named by a hostname, not spelled by an address', () => {
  afterEach(() => {
    setUpstreamResolver()
    vi.restoreAllMocks()
  })

  /**
   * A resolver that answers from a table, with no network involved.
   *
   * Installed through the module's own seam: patching `node:dns` does not intercept the named import
   * this module resolves through, so a `vi.spyOn` here would leave the real resolver answering — a
   * test that passes for the wrong reason.
   */
  function stubLookup(answers: Record<string, string[] | null>): ReturnType<typeof vi.fn> {
    const resolver = vi.fn(async (host: string) => answers[host] ?? null)
    setUpstreamResolver(resolver)
    return resolver
  }

  it('still catches the literal loopback spellings, which need no resolver', () => {
    // Unchanged behaviour, asserted first: the fix must not narrow what already worked.
    for (const url of ['http://127.0.0.1:6123', 'http://localhost:6123', 'http://[::1]:6123', 'http://127.1:6123', 'http://0.0.0.0:6123']) {
      expect(dialsPanel(url, [6123]), url).toBe(true)
    }
    expect(dialsPanel('http://10.0.0.5:6123', [6123])).toBe(false)
  })

  it('catches a name that resolves to loopback — the bypass', async () => {
    stubLookup({
      'panel.attacker.example': ['127.0.0.1'],
      '127.0.0.1.nip.io': ['127.0.0.1'],
      'v6.example': ['::1'],
      'mapped.example': ['::ffff:127.0.0.1'],
      // A name with several records is loopback if ANY of them is: the engine may pick either.
      'mixed.example': ['10.0.0.5', '127.0.0.1'],
    })
    const on = proxy({
      enabled: true,
      routes: [
        { id: 'sneaky', host: 'panel.attacker.example', target: 'external', url: 'http://panel.attacker.example:6123' },
        { id: 'nip', host: 'nip.example.com', target: 'external', url: 'http://127.0.0.1.nip.io:6123' },
        { id: 'v6', host: 'v6.example.com', target: 'external', url: 'http://v6.example:6123' },
        { id: 'mapped', host: 'mapped.example.com', target: 'external', url: 'http://mapped.example:6123' },
        { id: 'mixed', host: 'mixed.example.com', target: 'external', url: 'http://mixed.example:6123' },
      ],
    })
    await primeUpstreamResolutions(on)

    // Every one of them is a panel route, so the exposure bar applies to the whole table.
    expect(checkProxyExposure(on, true, false, false, [6123])).toContain('no password is set')
    expect(checkProxyExposure(on, true, true, false, [6123])).toBeNull()
    // And the predicate itself, so a caller that asks directly gets the same answer.
    for (const url of ['http://panel.attacker.example:6123', 'http://127.0.0.1.nip.io:6123', 'http://v6.example:6123', 'http://mixed.example:6123'])
      expect(dialsPanel(url, [6123]), url).toBe(true)
  })

  /** A name that resolves somewhere else is an ordinary upstream — the fix is not a blanket refusal. */
  it('leaves a name that resolves off-machine as an ordinary upstream', async () => {
    stubLookup({ 'app.example.com': ['10.0.0.5'] })
    const on = proxy({ enabled: true, routes: [{ id: 'app', host: 'app.example.com', target: 'external', url: 'http://app.example.com:6123' }] })
    await primeUpstreamResolutions(on)

    expect(dialsPanel('http://app.example.com:6123', [6123])).toBe(false)
    expect(checkProxyExposure(on, false, false, false, [6123])).toBeNull()
  })

  /**
   * A destination that cannot be established is not evidence of harmlessness.
   *
   * The asymmetry is the whole argument: refusing costs one retry, publishing costs the panel.
   */
  it('fails closed for a name that does not resolve', async () => {
    stubLookup({}) // every name is ENOTFOUND
    const on = proxy({ enabled: true, routes: [{ id: 'ghost', host: 'ghost.example.com', target: 'external', url: 'http://ghost.example.com:6123' }] })
    await primeUpstreamResolutions(on)

    expect(dialsPanel('http://ghost.example.com:6123', [6123]), 'an unknown destination is treated as the panel').toBe(true)
    expect(checkProxyExposure(on, true, false, false, [6123])).toContain('no password is set')
  })

  /** The predicate is synchronous and cached: a save must never wait on a resolver. */
  it('answers from a cache, and treats a name it has not resolved yet as the panel', async () => {
    const resolver = stubLookup({ 'app.example.com': ['10.0.0.5'] })
    // Never primed, so nothing is cached: the answer is still "points at the panel", and nothing was
    // awaited on the calling path — the background resolve is deliberately fire-and-forget.
    expect(dialsPanel('http://unprimed.example:6123', [6123])).toBe(true)
    expect(resolver, 'the predicate itself never blocks on a resolver').not.toHaveBeenCalledWith('app.example.com')

    // Priming is what puts an answer in the cache, and the second read is synchronous.
    await primeUpstreamResolutions(proxy({ enabled: true, routes: [{ id: 'a', host: 'app.example.com', target: 'external', url: 'http://app.example.com:6123' }] }))
    expect(dialsPanel('http://app.example.com:6123', [6123])).toBe(false)
    // A second predicate read costs no resolver call at all.
    const before = resolver.mock.calls.length
    expect(dialsPanel('http://app.example.com:6123', [6123])).toBe(false)
    expect(resolver.mock.calls.length).toBe(before)
  })

  /**
   * A failed resolve is remembered only briefly, so a resolver outage does not keep a legitimate
   * route refused once the network is back — while a positive answer is kept on the longer clock.
   */
  it('caches a failure briefly and a success for longer, on its own clock', async () => {
    const now = vi.spyOn(Date, 'now')
    try {
      let clock = 1_000_000
      now.mockImplementation(() => clock)

      let answers: string[] = []
      const resolver = vi.fn(async () => (answers.length === 0 ? null : answers))
      setUpstreamResolver(resolver)

      const config = proxy({ enabled: true, routes: [{ id: 'a', host: 'flaky.example', target: 'external', url: 'http://flaky.example:6123' }] })
      await primeUpstreamResolutions(config)
      expect(dialsPanel('http://flaky.example:6123', [6123]), 'a failure fails closed').toBe(true)

      // The resolver recovers, but the remembered failure is still inside its short window.
      answers = ['10.0.0.5']
      clock += 10_000
      await primeUpstreamResolutions(config)
      expect(dialsPanel('http://flaky.example:6123', [6123]), 'still inside the failure window').toBe(true)

      // Past it, the new answer is taken: a brief outage does not permanently refuse the route.
      clock += 30_000
      await primeUpstreamResolutions(config)
      expect(dialsPanel('http://flaky.example:6123', [6123]), 'the failure window closed').toBe(false)

      // And the success is not re-asked on every prime inside the longer window.
      const settled = resolver.mock.calls.length
      clock += 60_000
      await primeUpstreamResolutions(config)
      expect(resolver.mock.calls.length, 'a success is cached, not re-resolved each prime').toBe(settled)
      expect(dialsPanel('http://flaky.example:6123', [6123])).toBe(false)
    }
    finally {
      now.mockRestore()
    }
  })
})
