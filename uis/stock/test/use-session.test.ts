import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []

vi.mock('../src/lib/api', () => ({
  fetchSession: async (): Promise<unknown> => {
    calls.push('fetchSession')
    return {
      authenticated: true,
      authRequired: true,
      passwordSet: true,
      usingDefaultPassword: false,
      defaultPassword: null,
      sessionTtlMs: 604_800_000,
    }
  },
  login: async (): Promise<unknown> => {
    calls.push('login')
    return { authenticated: true }
  },
  logout: async (): Promise<void> => {
    calls.push('logout')
  },
  setPassword: async (): Promise<void> => {
    calls.push('setPassword')
  },
  clearPassword: async (): Promise<void> => {
    calls.push('clearPassword')
  },
}))

const { useSession } = await import('../src/composables/useSession')

beforeEach(() => {
  calls.length = 0
})

/**
 * The reported bug: `setPassword()` used `this.refresh()`, and the settings page
 * destructures the composable, so `this` was `undefined` — "Cannot read
 * properties of undefined (reading 'refresh')" — after the password had already
 * been changed on the server.
 */
describe('session composable', () => {
  it('works when destructured, like every caller uses it', async () => {
    const { setPassword, clearPassword, logout, login } = useSession()

    await expect(setPassword(undefined, 'a-new-password')).resolves.toBeNull()
    await expect(clearPassword()).resolves.toBeNull()
    await expect(logout()).resolves.toBeUndefined()
    await expect(login('whatever')).resolves.toBe(true)

    expect(calls).toEqual(['setPassword', 'fetchSession', 'clearPassword', 'fetchSession', 'logout', 'fetchSession', 'login'])
  })

  it('reports a failed password change instead of throwing', async () => {
    const api = await import('../src/lib/api')
    const original = api.setPassword
    vi.spyOn(api, 'setPassword').mockRejectedValueOnce(new Error('current password is incorrect'))

    const { setPassword } = useSession()
    await expect(setPassword('wrong', 'a-new-password')).resolves.toBe('current password is incorrect')

    vi.mocked(api.setPassword).mockImplementation(original)
  })
})
