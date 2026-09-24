import type { SessionView } from '@shared/contracts'
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
 * Session state for the whole SPA. Methods are plain functions rather than
 * object methods so a caller can destructure them without losing `this`.
 */
export function useSession() {
  return {
    session: readonly(session),
    error: readonly(error),
    refresh,

    async login(password: string): Promise<boolean> {
      error.value = null
      try {
        session.value = await api.login(password)
        return true
      }
      catch (caught) {
        error.value = caught instanceof Error ? caught.message : String(caught)
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

    async setPassword(current: string | undefined, next: string): Promise<string | null> {
      error.value = null
      try {
        await api.setPassword(current, next)
        await refresh()
        return null
      }
      catch (caught) {
        return caught instanceof Error ? caught.message : String(caught)
      }
    },

    async clearPassword(): Promise<string | null> {
      error.value = null
      try {
        await api.clearPassword()
        await refresh()
        return null
      }
      catch (caught) {
        return caught instanceof Error ? caught.message : String(caught)
      }
    },
  }
}
