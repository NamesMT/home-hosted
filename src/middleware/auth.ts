import type { Context, MiddlewareHandler } from 'hono'
import type { AuthIdentity, AuthService } from '#src/services/auth'
import type { HistoryActor } from '#src/shared/contracts'
import { DetailedError } from '@namesmt/utils'
import { secureCookieFor, serializeCookie } from '#src/helpers/cookies'
import { isLoopbackRequest } from '#src/middleware/loopback'
import { bearerToken, SESSION_COOKIE } from '#src/services/auth'

/**
 * Endpoints the SPA needs before it can show a login form, plus sign-out: it is idempotent and
 * CSRF-guarded, and a browser whose session already expired must still be able to clear its cookie.
 */
const PUBLIC_PATHS = new Set(['/api/auth/login', '/api/auth/session', '/api/auth/logout'])

/** 401s from the guard carry this code so the SPA can route to the login view. */
export const AUTH_REQUIRED_CODE = 'AUTH_REQUIRED'
/** Auth is off and the caller is not this machine (a remote peer, or anything a proxy relayed). */
export const AUTH_DISABLED_CODE = 'AUTH_DISABLED_REMOTE'

/**
 * The one place that reads a request's credentials, so the guard, the session
 * route and `/healthz` can never disagree about who is calling.
 */
export function requestIdentity(c: Context, auth: AuthService, options: { slide?: boolean } = {}): AuthIdentity {
  return auth.authenticate({
    cookieToken: auth.tokenFromCookie(c.req.header('cookie')),
    bearerToken: bearerToken(c.req.header('authorization')),
  }, options)
}

/**
 * Why this caller may not use `/api`, or null when it may. The guard asks at the door; an event
 * stream asks again on every ping and whenever a credential changes, so a stream authorised at
 * connect cannot outlive a sign-out, a password change or an expired session.
 */
export function accessRefusal(c: Context, auth: AuthService, identity: AuthIdentity): DetailedError | null {
  if (identity.authenticated)
    return null
  if (auth.isArmed())
    return new DetailedError('authentication required', { statusCode: 401, code: AUTH_REQUIRED_CODE })
  // No password to sign in with, so only this machine may look. A request relayed by a proxy —
  // even one on this machine — carries forwarding headers and is not "this machine".
  if (isLoopbackRequest(c))
    return null
  if (auth.isEnabled()) {
    return new DetailedError('authentication is enabled but no password is set — set one from the machine running the panel', {
      statusCode: 401,
      code: 'AUTH_UNARMED',
    })
  }
  return new DetailedError('authentication is off, so only this machine may use the panel — set a password (`home-hosted set-password`) to reach it through a proxy or from another machine', {
    statusCode: 401,
    code: AUTH_DISABLED_CODE,
  })
}

export interface AuthGuardDeps {
  auth: AuthService
  /** Test hook: bind the guard to an explicit cookie header / ip. */
  now?: () => number
}

/**
 * Guards every `/api/*` route. The SPA shell stays public (it holds no data),
 * so the browser can load the app and show the login screen.
 *
 * A request may prove itself with the session cookie or with an API token
 * (`Authorization: Bearer …`), which is what lets a script or an agent drive the
 * panel without a browser. Without a password (auth off, or on but unarmed) only
 * this machine — or the token — is trusted; see `accessRefusal`.
 *
 * State-changing requests that carry an `Origin` must come from this same host:
 * with `SameSite=Strict` cookies that closes the cross-site CSRF path.
 */
export function createAuthGuard(deps: AuthGuardDeps): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path

    if (path.startsWith('/api')) {
      const method = c.req.method
      // A browser never attaches a bearer token by itself, so a request carrying one cannot be a
      // cross-site forgery — which is what lets a desktop app or another origin use the API.
      const viaToken = bearerToken(c.req.header('authorization')) !== null && requestIdentity(c, deps.auth).method === 'token'
      if (method !== 'GET' && method !== 'HEAD' && !viaToken) {
        const origin = c.req.header('origin')
        if (origin !== undefined) {
          // `Host` is required by HTTP/1.1 but not guaranteed to be set by every
          // client, so fall back to the authority the server itself resolved.
          const requestHost = c.req.header('host') ?? new URL(c.req.url).host
          let originHost: string | null = null
          try {
            originHost = new URL(origin).host
          }
          catch {
            originHost = null
          }
          if (originHost === null || originHost !== requestHost)
            throw new DetailedError('cross-origin request rejected', { statusCode: 403, code: 'CROSS_ORIGIN' })
        }
      }

      if (!PUBLIC_PATHS.has(path)) {
        const identity = requestIdentity(c, deps.auth)
        const refusal = accessRefusal(c, deps.auth, identity)
        if (refusal !== null) {
          if (refusal.code === AUTH_REQUIRED_CODE && deps.auth.apiTokenSet)
            c.header('WWW-Authenticate', 'Bearer realm="home-hosted"')
          throw refusal
        }

        /**
         * An active session slides forward, so the browser's copy of the deadline has to slide with
         * it — otherwise it is dropped at the lifetime measured from *login*, whatever the person
         * did in between, and the panel signs its owner out mid-use.
         */
        if (deps.auth.isArmed() && identity.method === 'cookie' && identity.session !== null) {
          const maxAgeMs = deps.auth.refreshCookie(identity.session)
          if (maxAgeMs !== null) {
            c.header('Set-Cookie', serializeCookie(SESSION_COOKIE, identity.session.token, {
              maxAgeMs,
              secure: secureCookieFor(deps.auth.cookieSecureMode, new URL(c.req.url).protocol),
              sameSite: 'Strict',
              httpOnly: true,
            }))
          }
        }
      }
    }

    await next()
  }
}

export { SESSION_COOKIE }

/**
 * Who is behind a request, as a history event names them: a cookie is a person at
 * the panel, a bearer token is a script or an agent. Anonymous callers can only be
 * loopback requests while auth is unarmed, which is the browser's own origin.
 */
export function requestActor(c: Context, auth: AuthService): HistoryActor {
  return requestIdentity(c, auth).method === 'token' ? 'agent' : 'user'
}

export { isLoopbackRequest, requestIp } from '#src/middleware/loopback'
