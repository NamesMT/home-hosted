import type { Context } from 'hono'
import type { AppDeps } from '#src/app'
import type { LoginRequest, PasswordRequest } from '#src/shared/contracts'
import { DetailedError } from '@namesmt/utils'
import { describeRoute } from 'hono-openapi'
import { serializeCookie } from '#src/helpers/cookies'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { AUTH_REQUIRED_CODE, SESSION_COOKIE } from '#src/middleware/auth'
import { isLoopbackRequest, requestIp } from '#src/middleware/loopback'
import { checkExposure } from '#src/services/exposure'
import { loginSchema, passwordSchema, sessionViewSchema } from '#src/shared/contracts'

/** `Secure` only helps over TLS, and would break plain http on a LAN. */
function secureCookie(c: Context, deps: AppDeps): boolean {
  const mode = deps.store.config.control.auth.cookieSecure
  if (mode === 'always')
    return true
  if (mode === 'never')
    return false
  return new URL(c.req.url).protocol === 'https:'
}

export function createAuthRoute(deps: AppDeps) {
  return appFactory.createApp()
    .get(
      '/auth/session',
      describeRoute({
        tags: ['auth'],
        summary: 'Who this request is, and how the panel is protected',
        responses: { 200: { description: 'Session', content: jsonBody(sessionViewSchema) } },
      }),
      c => c.json(deps.auth.sessionView(deps.auth.tokenFromCookie(c.req.header('cookie')))),
    )

    .post(
      '/auth/login',
      describeRoute({
        tags: ['auth'],
        summary: 'Exchange the panel password for a session cookie',
        responses: {
          200: { description: 'Signed in', content: jsonBody(sessionViewSchema) },
          400: ERROR_RESPONSES[400],
          401: { description: 'Wrong password, or locked out (see `Retry-After`)' },
        },
      }),
      validate('json', loginSchema),
      (c) => {
        const body: LoginRequest = c.req.valid('json')
        const outcome = deps.auth.login(body.password, requestIp(c))

        if (!outcome.ok) {
          if (outcome.retryAfterMs !== undefined)
            c.header('Retry-After', String(Math.ceil(outcome.retryAfterMs / 1000)))
          throw new DetailedError(outcome.error, { statusCode: outcome.status, code: 'LOGIN_FAILED' })
        }

        c.header('Set-Cookie', serializeCookie(SESSION_COOKIE, outcome.token, {
          maxAgeMs: outcome.maxAgeMs,
          secure: secureCookie(c, deps),
          sameSite: 'Strict',
          httpOnly: true,
        }))

        return c.json(deps.auth.sessionView(outcome.token))
      },
    )

    .post(
      '/auth/logout',
      describeRoute({
        tags: ['auth'],
        summary: 'Drop the session cookie',
        responses: { 200: { description: 'Signed out' } },
      }),
      (c) => {
        deps.auth.logout(deps.auth.tokenFromCookie(c.req.header('cookie')))
        c.header('Set-Cookie', serializeCookie(SESSION_COOKIE, '', {
          maxAgeMs: 0,
          secure: secureCookie(c, deps),
          sameSite: 'Strict',
          httpOnly: true,
        }))
        return c.json({ ok: true })
      },
    )

    /**
     * First-time setup is allowed from loopback without a session (there is
     * nothing to authenticate against yet); every later change needs the session
     * and* the current password.
     */
    .post(
      '/auth/password',
      describeRoute({
        tags: ['auth'],
        summary: 'Set, change or enable the panel password',
        responses: { 200: { description: 'Updated' }, 400: ERROR_RESPONSES[400], 401: ERROR_RESPONSES[401] },
      }),
      validate('json', passwordSchema),
      (c) => {
        const body: PasswordRequest = c.req.valid('json')
        const hadPassword = deps.auth.passwordSet
        const authenticated = deps.auth.validate(deps.auth.tokenFromCookie(c.req.header('cookie'))) !== null
        const firstSetup = !hadPassword && isLoopbackRequest(c)

        if (!authenticated && !firstSetup)
          throw new DetailedError('authentication required', { statusCode: 401, code: AUTH_REQUIRED_CODE })

        if (authenticated && hadPassword) {
          if (body.currentPassword === undefined)
            throw new DetailedError('currentPassword is required to change an existing password', { statusCode: 400, code: 'CURRENT_PASSWORD_REQUIRED' })
          if (!deps.auth.verifyCurrentPassword(body.currentPassword))
            throw new DetailedError('current password is incorrect', { statusCode: 401, code: 'CURRENT_PASSWORD_WRONG' })
        }

        // Keep the caller signed in: every *other* session is dropped.
        deps.auth.setPassword(body.newPassword, { keepToken: deps.auth.tokenFromCookie(c.req.header('cookie')) })

        // A password that is not enforced protects nothing, so the first setup enables it.
        let enabled = deps.store.config.control.auth.enabled
        if (!enabled) {
          deps.store.updateControl({ auth: { enabled: true } })
          enabled = true
        }

        return c.json({ ok: true, enabled, sessionsInvalidated: true })
      },
    )

    .delete(
      '/auth/password',
      describeRoute({
        tags: ['auth'],
        summary: 'Clear the password and turn authentication off',
        responses: { 200: { description: 'Cleared' }, 400: ERROR_RESPONSES[400], 401: ERROR_RESPONSES[401] },
      }),
      (c) => {
        if (deps.auth.validate(deps.auth.tokenFromCookie(c.req.header('cookie'))) === null)
          throw new DetailedError('authentication required', { statusCode: 401, code: AUTH_REQUIRED_CODE })

        const exposure = checkExposure(deps.store.config.control, false)
        if (exposure.exposed) {
          throw new DetailedError('refusing to clear the password while the control panel is bound beyond loopback — set the bind back to local first', {
            statusCode: 400,
            code: 'EXPOSED_WITHOUT_PASSWORD',
          })
        }

        deps.auth.clearPassword()
        deps.store.updateControl({ auth: { enabled: false } })
        return c.json({ ok: true })
      },
    )
}
