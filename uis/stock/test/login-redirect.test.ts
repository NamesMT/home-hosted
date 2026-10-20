import { describe, expect, it } from 'vitest'
import { loginRedirect } from '../src/lib/login-redirect'

/**
 * When the login page is shown, and when it is skipped.
 *
 * The panel has a whole first-run variant of that page — "This panel has no password yet", and
 * the one sentence that names the command to set one — and the guard made it unreachable: it
 * redirected away from `/login` whenever `authRequired` was false, which is exactly the
 * no-password state. The screen written to rescue an unprotected panel could not be opened from
 * the panel itself.
 */
describe('loginRedirect', () => {
  const page = (name: string) => ({ name, fullPath: `/${name}` })

  it('sends an anonymous visitor to the login page', () => {
    const redirect = loginRedirect(page('global-overview'), { authRequired: true, authenticated: false, passwordSet: true })
    expect(redirect).toMatchObject({ name: 'login' })
  })

  it('leaves an authenticated visitor alone', () => {
    expect(loginRedirect(page('servers'), { authRequired: true, authenticated: true, passwordSet: true })).toBeNull()
  })

  it('leaves the login page reachable when no password is set', () => {
    // `authRequired` is `enabled && passwordSet`, so a cleared password makes it false — and the
    // old rule read that as "you may not see the login page".
    const redirect = loginRedirect(page('login'), { authRequired: false, authenticated: false, passwordSet: false })
    expect(redirect).toBeNull()
  })

  it('still moves a signed-in visitor off the login page', () => {
    expect(loginRedirect(page('login'), { authRequired: true, authenticated: true, passwordSet: true }))
      .toMatchObject({ name: 'global-overview', replace: true })
  })

  it('keeps the requested path so a deep link survives signing in', () => {
    const redirect = loginRedirect({ name: 'servers', fullPath: '/w/default/servers' }, { authRequired: true, authenticated: false, passwordSet: true })
    expect(redirect).toMatchObject({ name: 'login', query: { next: '/w/default/servers' } })
  })

  it('does not attach a next for the root path', () => {
    const redirect = loginRedirect({ name: 'home', fullPath: '/' }, { authRequired: true, authenticated: false, passwordSet: true })
    expect(redirect).not.toHaveProperty('query')
  })
})
