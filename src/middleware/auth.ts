import type { Context, MiddlewareHandler } from 'hono'
import type { AuthIdentity, AuthService } from '#src/services/auth'
import { DetailedError } from '@namesmt/utils'
import { isLoopbackRequest } from '#src/middleware/loopback'
import { bearerToken, SESSION_COOKIE } from '#src/services/auth'

/** Endpoints the SPA needs before it can show a login form. */
const PUBLIC_PATHS = new Set(['/api/auth/login', '/api/auth/session'])

/** 401s from the guard carry this code so the SPA can route to the login view. */
export const AUTH_REQUIRED_CODE = 'AUTH_REQUIRED'

/**
 * The one place that reads a request's credentials, so the guard, the session
 * route and `/healthz` can never disagree about who is calling.
 */
export function requestIdentity(c: Context, auth: AuthService): AuthIdentity {
  return auth.authenticate({
    cookieToken: auth.tokenFromCookie(c.req.header('cookie')),
    bearerToken: bearerToken(c.req.header('authorization')),
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
 * panel without a browser. The token also works while auth is enabled but no
 * password is set — that state otherwise only trusts this machine.
 *
 * State-changing requests that carry an `Origin` must come from this same host:
 * with `SameSite=Strict` cookies that closes the cross-site CSRF path.
 */
export function createAuthGuard(deps: AuthGuardDeps): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path

    if (path.startsWith('/api')) {
      const method = c.req.method
      if (method !== 'GET' && method !== 'HEAD') {
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

        if (deps.auth.isArmed()) {
          if (!identity.authenticated) {
            if (deps.auth.apiTokenSet)
              c.header('WWW-Authenticate', 'Bearer realm="home-hosted"')
            throw new DetailedError('authentication required', { statusCode: 401, code: AUTH_REQUIRED_CODE })
          }
        }
        else if (deps.auth.isEnabled()) {
          // Enabled but not armed: only an API token or this machine may look. A
          // proxied request must set `trustProxy` to be seen as remote, otherwise
          // it is indistinguishable from a local one.
          if (!identity.authenticated && !isLoopbackRequest(c)) {
            throw new DetailedError('authentication is enabled but no password is set — set one from the machine running the panel', {
              statusCode: 401,
              code: 'AUTH_UNARMED',
            })
          }
        }
      }
    }

    await next()
  }
}

export { SESSION_COOKIE }

export { isLoopbackRequest, requestIp } from '#src/middleware/loopback'
