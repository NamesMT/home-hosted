import type { Context } from 'hono'
import type { AppDeps } from '#src/app'
import type { AuthIdentity } from '#src/services/auth'
import type { LoginRequest } from '#src/shared/contracts'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { describeRoute } from 'hono-openapi'
import { bodyLimit } from 'hono/body-limit'
import { secureCookieFor, serializeCookie } from '#src/helpers/cookies'
import { appFactory } from '#src/helpers/factory'
import { ERROR_RESPONSES, jsonBody } from '#src/helpers/openapi'
import { validate } from '#src/helpers/validator'
import { AUTH_REQUIRED_CODE, requestIdentity, SESSION_COOKIE } from '#src/middleware/auth'
import { requestIp } from '#src/middleware/loopback'
import { tokenAllows } from '#src/middleware/token-scope'
import { checkExposure, checkProxyExposure } from '#src/services/exposure'
import { accountCreatedBodySchema, accountCreateSchema, accountIdBodySchema, accountListSchema, accountPatchSchema, accountSecretSchema, loginSchema, okResponseSchema, sessionViewSchema } from '#src/shared/contracts'
import { lazy } from '#src/shared/lazy'
import { credentialOf } from '#src/shared/meta'
import { EXPOSED_PASSWORD_MIN_LENGTH, passwordLength } from '#src/shared/password-policy'

/** An account id, as the account routes take it. Ids are lowercase slugs. */
const accountIdParam = lazy(() => type({ id: 'string >= 1' }))

/** `Secure` only helps over TLS, and would break plain http on a LAN. */
function secureCookie(c: Context, deps: AppDeps): boolean {
  return secureCookieFor(deps.auth.cookieSecureMode, new URL(c.req.url).protocol)
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
      (c) => {
        const identity = requestIdentity(c, deps.auth)
        return c.json(deps.auth.sessionView(identity.authenticated, credentialOf(identity, deps.auth.apiTokenHint)))
      },
    )

    .post(
      '/auth/login',
      describeRoute({
        tags: ['auth'],
        summary: 'Exchange an account id and secret for a session cookie',
        responses: {
          200: { description: 'Signed in', content: jsonBody(sessionViewSchema) },
          400: ERROR_RESPONSES[400],
          401: { description: 'Wrong account id or secret, or locked out (see `Retry-After`)' },
        },
      }),
      // Unauthenticated by nature, so the body is bounded before it is parsed.
      bodyLimit({
        maxSize: 4096,
        onError: () => {
          throw new DetailedError('the login request is too large', { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' })
        },
      }),
      validate('json', loginSchema),
      (c) => {
        const body: LoginRequest = c.req.valid('json')
        const outcome = deps.auth.login(body.id, body.secret, requestIp(c))

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

        return c.json(deps.auth.sessionView(true, { kind: 'session' }))
      },
    )

    .post(
      '/auth/logout',
      describeRoute({
        tags: ['auth'],
        summary: 'Drop the session cookie',
        responses: { 200: { description: 'Signed out', content: jsonBody(okResponseSchema) } },
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
     * Create an account. Session only, and `admin`-scoped.
     *
     * A credential that could mint another would let a leaked one escalate: it could create an
     * account it knows the secret of and hold that after its own is revoked. `admin` alone is not
     * enough either — the actor must be a session, so a stolen token cannot turn itself into a
     * permanent one.
     */
    .post(
      '/auth/accounts',
      describeRoute({
        tags: ['auth'],
        summary: 'Create an account (signed-in session required)',
        description: 'The secret is returned **once**; only a hash is stored. Omit `secret` to have the panel generate one.',
        responses: {
          201: { description: 'The account, with its secret shown once', content: jsonBody(accountCreatedBodySchema) },
          400: ERROR_RESPONSES[400],
          401: ERROR_RESPONSES[401],
          403: { description: 'Needs a session and the `admin` scope (`SESSION_REQUIRED`)' },
          409: { description: 'An account with that id already exists (`ACCOUNT_EXISTS`)' },
        },
      }),
      validate('json', accountCreateSchema),
      (c) => {
        requireAdminSession(c, deps, 'creating an account')
        const body = c.req.valid('json')
        try {
          const created = deps.secrets.createAccount({
            id: body.id,
            ...(body.label === undefined ? {} : { label: body.label }),
            scopes: body.scopes,
            ...(body.workspaces === undefined ? {} : { workspaces: body.workspaces }),
            ...(body.secret === undefined ? {} : { secret: body.secret }),
          })
          deps.auth.notifyCredentialsChanged()
          return c.json({ account: created.account, secret: created.secret }, 201)
        }
        catch (error) {
          // The refusals a person fixes by typing something else, so they keep their own sentence.
          throw new DetailedError(error instanceof Error ? error.message : String(error), { statusCode: 409, code: 'ACCOUNT_EXISTS' })
        }
      },
    )

    .get(
      '/auth/accounts',
      describeRoute({
        tags: ['auth'],
        summary: 'Every account, without its secret (signed-in session required)',
        responses: { 200: { description: 'The accounts', content: jsonBody(accountListSchema) }, 401: ERROR_RESPONSES[401], 403: { description: 'Needs a session and the `admin` scope' } },
      }),
      (c) => {
        requireAdminSession(c, deps, 'listing accounts')
        return c.json({ accounts: deps.auth.listAccounts() })
      },
    )

    .patch(
      '/auth/accounts/:id',
      describeRoute({
        tags: ['auth'],
        summary: 'Change an account\'s label, scopes, workspace limit or enabled flag (session required)',
        responses: { 200: { description: 'Updated', content: jsonBody(accountIdBodySchema) }, 400: ERROR_RESPONSES[400], 401: ERROR_RESPONSES[401], 403: { description: 'Needs a session and the `admin` scope' }, 404: ERROR_RESPONSES[404] },
      }),
      validate('param', accountIdParam),
      validate('json', accountPatchSchema),
      (c) => {
        requireAdminSession(c, deps, 'changing an account')
        const { id } = c.req.valid('param')
        const body = c.req.valid('json')
        const updated = deps.auth.updateAccount(id, body)
        if (updated === null)
          throw new DetailedError(`no account with the id "${id}"`, { statusCode: 404, code: 'UNKNOWN_ACCOUNT' })
        return c.json({ account: updated })
      },
    )

    .delete(
      '/auth/accounts/:id',
      describeRoute({
        tags: ['auth'],
        summary: 'Revoke an account, and end its sessions (signed-in session required)',
        description: 'Refused for the account that is asking, and for the last account that can sign in — either would lock the panel.',
        responses: { 200: { description: 'Revoked', content: jsonBody(okResponseSchema) }, 400: ERROR_RESPONSES[400], 401: ERROR_RESPONSES[401], 403: { description: 'Needs a session and the `admin` scope' }, 404: ERROR_RESPONSES[404] },
      }),
      validate('param', accountIdParam),
      (c) => {
        const identity = requireAdminSession(c, deps, 'revoking an account')
        const { id } = c.req.valid('param')
        // Revoking the credential you are using is a mistake, not an attack: say so and stop.
        if (identity.account?.id === id)
          throw new DetailedError('that is the account you are signed in as — sign in as another one to revoke it', { statusCode: 400, code: 'CANNOT_REVOKE_SELF' })
        const remaining = deps.auth.listAccounts().filter(entry => entry.id !== id && entry.enabled)
        if (remaining.length === 0)
          throw new DetailedError('that is the last account that can sign in — create another first, or the panel would have no way in', { statusCode: 400, code: 'LAST_ACCOUNT' })
        if (!deps.auth.revokeAccount(id))
          throw new DetailedError(`no account with the id "${id}"`, { statusCode: 404, code: 'UNKNOWN_ACCOUNT' })
        return c.json({ ok: true })
      },
    )

    /**
     * Change **your own** secret.
     *
     * The current secret is required, for the same reason the password change demanded it: a stolen
     * cookie must not become a permanent takeover. The session that made the change stays signed in —
     * being thrown out of the page you just used reads as a failure.
     */
    .post(
      '/auth/accounts/me/secret',
      describeRoute({
        tags: ['auth'],
        summary: 'Set a new secret for the signed-in account (signed-in session required)',
        responses: { 200: { description: 'Updated', content: jsonBody(okResponseSchema) }, 400: ERROR_RESPONSES[400], 401: ERROR_RESPONSES[401], 403: { description: 'Needs a signed-in session (`SESSION_REQUIRED`)' } },
      }),
      validate('json', accountSecretSchema),
      (c) => {
        const identity = requireSession(c, deps, 'changing an account secret')
        const accountId = identity.account?.id
        if (accountId === undefined)
          throw new DetailedError('a session must belong to an account', { statusCode: 403, code: 'SESSION_REQUIRED' })
        const body = c.req.valid('json')

        if (body.currentSecret === undefined)
          throw new DetailedError('currentSecret is required to change an existing secret', { statusCode: 400, code: 'CURRENT_PASSWORD_REQUIRED' })
        if (!deps.auth.verifyAccountSecret(accountId, body.currentSecret))
          throw new DetailedError('the current secret is incorrect', { statusCode: 401, code: 'CURRENT_PASSWORD_WRONG' })

        // A secret too short for exposure would leave an exposed panel refusing its next start, so it
        // is refused while the listener (or a proxy route to the panel) is exposed. On loopback any
        // length is accepted.
        if (passwordLength(body.newSecret) < EXPOSED_PASSWORD_MIN_LENGTH) {
          const control = deps.panel.settings.control
          const reason = checkExposure({ ...control, host: deps.controlServer.endpoint.host }, true, false, true).blockedReason
            ?? checkExposure(control, true, false, true).blockedReason
            ?? checkProxyExposure(deps.proxy.config, control.auth.enabled, true, false, [deps.controlServer.endpoint.port, control.port], true)
          if (reason !== null)
            throw new DetailedError(reason, { statusCode: 400, code: 'PASSWORD_TOO_SHORT' })
        }

        deps.auth.setAccountSecret(accountId, body.newSecret, { keepToken: identity.session?.token ?? null })

        // A secret that is not enforced protects nothing, so a first setup enables auth.
        if (!deps.panel.settings.control.auth.enabled)
          deps.panel.settings.updateControl({ auth: { enabled: true } })

        return c.json({ ok: true })
      },
    )

    .delete(
      '/auth/password',
      describeRoute({
        tags: ['auth'],
        summary: 'Turn authentication off (signed-in session required)',
        description: 'The accounts stay on disk — this switches the guard off, so the next start is unarmed until an account signs in again.',
        responses: { 200: { description: 'Disabled', content: jsonBody(okResponseSchema) }, 400: ERROR_RESPONSES[400], 401: ERROR_RESPONSES[401], 403: { description: 'A bearer credential may not turn authentication off' } },
      }),
      (c) => {
        const identity = requestIdentity(c, deps.auth)
        if (!identity.authenticated)
          throw new DetailedError('authentication required', { statusCode: 401, code: AUTH_REQUIRED_CODE })

        /**
         * A **session**, not merely an identity, because clearing the password is the other way
         * authentication goes away. A bearer token must not be able to do it: `POST` refuses to
         * rewrite a password it already has without `currentPassword` (so a stolen token cannot
         * arm the panel), and a token that could `DELETE` instead would reach the same end —
         * `DELETE`, then `POST` a new password with none set, needing no current one. The refusal
         * names the two real paths, both of which the person can follow.
         */
        if (identity.method !== 'cookie') {
          throw new DetailedError('turning authentication off needs a signed-in session, not a bearer credential — sign in at the panel, or run `home-hosted account disable-auth` on the machine', {
            statusCode: 403,
            code: 'SESSION_REQUIRED',
          })
        }

        const exposure = checkExposure(deps.panel.settings.control, false)
        if (exposure.exposed) {
          throw new DetailedError('refusing to clear the password while the control panel is bound beyond loopback — set the bind back to local first', {
            statusCode: 400,
            code: 'EXPOSED_WITHOUT_PASSWORD',
          })
        }

        // Clearing the password is the other way authentication goes away, so the
        // proxy's own exposure rule has to hold here too: a route with `target: "panel"`
        // serves this control panel on a public hostname, and that guard only runs when a
        // route is written.
        const proxyExposure = checkProxyExposure(deps.proxy.config, false, false, false, [deps.controlServer.endpoint.port, deps.panel.settings.control.port])
        if (proxyExposure !== null)
          throw new DetailedError(proxyExposure, { statusCode: 400, code: 'PROXY_EXPOSURE_BLOCKED' })

        // The accounts are **not** deleted: switching the guard off is not the same as losing the way
        // in, and a person who does this by mistake can switch it back on without re-creating one.
        deps.auth.logoutAll()
        deps.panel.settings.updateControl({ auth: { enabled: false } })
        return c.json({ ok: true })
      },
    )
}

/**
 * A signed-in **session**, not merely a bearer credential.
 *
 * Managing credentials is the one class of action a credential may not perform on itself: an account
 * that could create or revoke another could escalate past its own scopes, and a stolen secret could
 * make itself permanent. Returns the identity so a caller can compare the acting account.
 */
function requireSession(c: Context, deps: AppDeps, what: string): AuthIdentity {
  const identity = requestIdentity(c, deps.auth)
  if (!identity.authenticated)
    throw new DetailedError('authentication required', { statusCode: 401, code: AUTH_REQUIRED_CODE })
  if (identity.method !== 'cookie')
    throw new DetailedError(`${what} needs a signed-in session, not an API credential — sign in at the panel, or run \`home-hosted account\` on the machine`, { statusCode: 403, code: 'SESSION_REQUIRED' })
  return identity
}

/** A session whose account holds `admin`. Creating an account is a privilege escalation otherwise. */
function requireAdminSession(c: Context, deps: AppDeps, what: string): AuthIdentity {
  const identity = requireSession(c, deps, what)
  if (identity.account === undefined || !tokenAllows(identity.account.scopes, 'admin'))
    throw new DetailedError(`${what} needs an account with the \`admin\` scope`, { statusCode: 403, code: 'TOKEN_SCOPE' })
  return identity
}
