import type { SessionView } from '@shared/contracts'
import { errorMessage } from '@shared/error-message'
import { readonly, ref } from 'vue'
import * as api from '@/lib/api'

const session = ref<SessionView | null>(null)
const error = ref<string | null>(null)

/**
 * What the shell should do about the live event stream.
 *
 * This is a value rather than two flags on purpose: the session lands
 * asynchronously, and with authentication off `authRequired` *and*
 * `authenticated` are both false from the first paint to the last, so a watcher
 * on those flags alone never ran — the shell never opened its stream and the
 * dashboard never updated on its own.
 */
export type StreamDecision = 'wait' | 'connect' | 'login'

export function streamDecision(session: SessionView | null): StreamDecision {
  if (session === null)
    return 'wait'
  return session.authRequired && !session.authenticated ? 'login' : 'connect'
}

/**
 * Session state for the whole SPA. `requireLogin` lets any failed request flip
 * the UI back to the login view without every caller knowing about 401s.
 *
 * Everything here is a plain closure rather than a method on the returned
 * object: callers destructure it (`const { setMySecret } = useSession()`), and a
 * `this.refresh()` inside would then be `undefined.refresh()`.
 */
export function useSession() {
  async function refresh(): Promise<void> {
    try {
      session.value = await api.fetchSession()
    }
    catch {
      session.value = null
    }
  }

  async function login(id: string, secret: string): Promise<boolean> {
    error.value = null
    try {
      session.value = await api.login(id, secret)
      return true
    }
    catch (caught) {
      error.value = errorMessage(caught)
      return false
    }
  }

  async function logout(): Promise<void> {
    try {
      await api.logout()
    }
    finally {
      await refresh()
    }
  }

  /** Called when the API answers 401 so the guard can route to the login view. */
  function requireLogin(): void {
    session.value = {
      authenticated: false,
      authRequired: true,
      passwordSet: session.value?.passwordSet ?? true,
      apiTokenSet: session.value?.apiTokenSet ?? false,
      usingDefaultPassword: session.value?.usingDefaultPassword ?? false,
      // Omitted rather than `null`: the field is `defaultPassword?: string`, absent unless the
      // panel is still on its first-run password.
      ...(session.value?.defaultPassword === undefined ? {} : { defaultPassword: session.value.defaultPassword }),
      sessionTtlMs: session.value?.sessionTtlMs ?? 0,
    }
  }

  /** Replaces **this** account's secret, proving the current one. */
  async function setMySecret(current: string | undefined, next: string): Promise<string | null> {
    error.value = null
    try {
      await api.setMySecret(current, next)
      await refresh()
      return null
    }
    catch (caught) {
      return errorMessage(caught)
    }
  }

  /** Turns the guard off. The accounts stay on disk. */
  async function disableAuth(): Promise<string | null> {
    error.value = null
    try {
      await api.disableAuth()
      await refresh()
      return null
    }
    catch (caught) {
      return errorMessage(caught)
    }
  }

  return {
    session: readonly(session),
    error: readonly(error),
    refresh,
    login,
    logout,
    requireLogin,
    setMySecret,
    disableAuth,
  }
}
