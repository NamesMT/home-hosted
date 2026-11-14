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
      // Absent, not `null`: the panel omits the field unless it is still on its first-run password.
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
  setMySecret: async (): Promise<void> => {
    calls.push('setMySecret')
  },
  disableAuth: async (): Promise<void> => {
    calls.push('disableAuth')
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
    const { setMySecret, disableAuth, logout, login } = useSession()

    await expect(setMySecret(undefined, 'a-new-password')).resolves.toBeNull()
    await expect(disableAuth()).resolves.toBeNull()
    await expect(logout()).resolves.toBeUndefined()
    // The credential is two halves now, so signing in takes both.
    await expect(login('default', 'whatever')).resolves.toBe(true)

    expect(calls).toEqual(['setMySecret', 'fetchSession', 'disableAuth', 'fetchSession', 'logout', 'fetchSession', 'login'])
  })

  it('reports a failed password change instead of throwing', async () => {
    const api = await import('../src/lib/api')
    const original = api.setMySecret
    vi.spyOn(api, 'setMySecret').mockRejectedValueOnce(new Error('the current secret is incorrect'))

    const { setMySecret } = useSession()
    await expect(setMySecret('wrong', 'a-new-password')).resolves.toBe('the current secret is incorrect')

    vi.mocked(api.setMySecret).mockImplementation(original)
  })
})
