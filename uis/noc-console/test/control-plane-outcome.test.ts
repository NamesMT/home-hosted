import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `run()` and `ensureState()` against a panel that does not answer.
 *
 * A deep link opened while the panel restarted rethrew out of the router guard and left a blank
 * page; and a save whose follow-up state read failed was reported as a failed save.
 */
const fetchState = vi.fn<() => Promise<unknown>>()
const patchServer = vi.fn<() => Promise<unknown>>()
const fetchSession = vi.fn<() => Promise<unknown>>()
vi.mock('@/lib/api', async original => ({
  ...await original<typeof import('../src/lib/api')>(),
  fetchState: () => fetchState(),
  patchServer: () => patchServer(),
  fetchSession: () => fetchSession(),
}))

beforeEach(() => {
  vi.resetModules()
  fetchState.mockReset()
  patchServer.mockReset()
  fetchSession.mockReset()
})

describe('the console control plane', () => {
  it('lets a guarded route through when the first frame cannot be read', async () => {
    fetchState.mockRejectedValue(new Error('connection refused'))
    const { useControlPlane } = await import('../src/composables/useControlPlane')
    await expect(useControlPlane().ensureState()).resolves.toBeUndefined()
  })

  it('re-reads the session when the first frame finds it gone', async () => {
    const { AuthRequiredError } = await import('../src/lib/api')
    fetchState.mockRejectedValue(new AuthRequiredError())
    fetchSession.mockResolvedValue({ authRequired: true, authenticated: false })
    const { useControlPlane } = await import('../src/composables/useControlPlane')
    const { useSession } = await import('../src/composables/useSession')
    await useControlPlane().ensureState()
    expect(useSession().session.value).toMatchObject({ authRequired: true, authenticated: false })
  })

  it('reports a save as saved when only the refresh after it failed', async () => {
    patchServer.mockResolvedValue({ ok: true })
    fetchState.mockRejectedValue(new Error('panel restarting'))
    const { useControlPlane } = await import('../src/composables/useControlPlane')
    const outcome = await useControlPlane().saveConfig('default', 'web', { command: 'node' })
    expect(outcome.ok).toBe(true)
  })
})
