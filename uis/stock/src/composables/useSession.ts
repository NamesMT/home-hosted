import type { SessionView } from '@shared/contracts'
import { readonly, ref } from 'vue'
import * as api from '@/lib/api'

const session = ref<SessionView | null>(null)
const error = ref<string | null>(null)

/**
 * Session state for the whole SPA. `requireLogin` lets any failed request flip
 * the UI back to the login view without every caller knowing about 401s.
 *
 * Everything here is a plain closure rather than a method on the returned
 * object: callers destructure it (`const { setPassword } = useSession()`), and a
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

  async function login(password: string): Promise<boolean> {
    error.value = null
    try {
      session.value = await api.login(password)
      return true
    }
    catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught)
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
      defaultPassword: session.value?.defaultPassword ?? null,
      sessionTtlMs: session.value?.sessionTtlMs ?? 0,
    }
  }

  async function setPassword(current: string | undefined, next: string): Promise<string | null> {
    error.value = null
    try {
      await api.setPassword(current, next)
      await refresh()
      return null
    }
    catch (caught) {
      return caught instanceof Error ? caught.message : String(caught)
    }
  }

  async function clearPassword(): Promise<string | null> {
    error.value = null
    try {
      await api.clearPassword()
      await refresh()
      return null
    }
    catch (caught) {
      return caught instanceof Error ? caught.message : String(caught)
    }
  }

  return {
    session: readonly(session),
    error: readonly(error),
    refresh,
    login,
    logout,
    requireLogin,
    setPassword,
    clearPassword,
  }
}
