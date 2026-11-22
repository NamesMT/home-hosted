import type { SessionView } from '@shared/contracts'
import { errorMessage } from '@shared/error-message'
import { readonly, ref } from 'vue'
import * as api from '@/lib/api'

const session = ref<SessionView | null>(null)
const error = ref<string | null>(null)

async function refresh(): Promise<void> {
  try {
    session.value = await api.fetchSession()
  }
  catch {
    session.value = null
  }
}

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
 * Session state for the whole SPA. Methods are plain functions rather than
 * object methods so a caller can destructure them without losing `this`.
 */
export function useSession() {
  return {
    session: readonly(session),
    error: readonly(error),
    refresh,

    /** The credential is two halves: an id you type and a secret only you hold. */
    async login(id: string, secret: string): Promise<boolean> {
      error.value = null
      try {
        session.value = await api.login(id, secret)
        return true
      }
      catch (caught) {
        error.value = errorMessage(caught)
        return false
      }
    },

    async logout(): Promise<void> {
      try {
        await api.logout()
      }
      finally {
        await refresh()
      }
    },

    /** Replaces **this** account's secret, proving the current one. */
    async setMySecret(current: string | undefined, next: string): Promise<string | null> {
      error.value = null
      try {
        await api.setMySecret(current, next)
        await refresh()
        return null
      }
      catch (caught) {
        return errorMessage(caught)
      }
    },

    /** Turns the guard off. The accounts stay on disk. */
    async disableAuth(): Promise<string | null> {
      error.value = null
      try {
        await api.disableAuth()
        await refresh()
        return null
      }
      catch (caught) {
        return errorMessage(caught)
      }
    },
  }
}
