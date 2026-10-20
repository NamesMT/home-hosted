/**
 * The login guard's decision, as a pure function.
 *
 * Kept out of `router.ts` so it is testable without a DOM: importing that module runs
 * `createWebHistory()`, which needs a `window`.
 */

/** The minimum a session has to answer, so a test needs no full `SessionView`. */
export interface LoginSession {
  authRequired?: boolean
  authenticated?: boolean
  passwordSet?: boolean
}

/**
 * Whether the guard should turn this navigation away, and to where.
 *
 * Pure, so the rule is testable without a router: the session shape is the whole input.
 */
export function loginRedirect(
  to: { name?: unknown, fullPath: string },
  session: { authRequired?: boolean, authenticated?: boolean, passwordSet?: boolean } | null,
): { name: 'login' | 'global-overview', query?: { next: string }, replace?: true } | null {
  const required = session?.authRequired === true
  const authenticated = session?.authenticated === true

  if (required && !authenticated && to.name !== 'login')
    return { name: 'login', ...(to.fullPath === '/' ? {} : { query: { next: to.fullPath } }) }
  /**
   * Only a *signed-in* visitor is sent away from `/login`. The condition used to be
   * `!required || authenticated`, and `required` is `enabled && passwordSet` — so the
   * no-password state also redirected, and the login page's first-run variant ("This panel has
   * no password yet", plus the sentence naming the command to set one) could never render. The
   * screen written to rescue an unprotected panel was unreachable from the panel itself.
   */
  if (to.name === 'login' && authenticated)
    return { name: 'global-overview', replace: true }
  return null
}
