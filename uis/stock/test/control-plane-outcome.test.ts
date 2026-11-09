import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Every action resolves to its own outcome.
 *
 * A shared `lastError` was overwritten by whichever action finished last, so a failed Start
 * elsewhere showed inside an open config editor and kept it open after its own save succeeded;
 * and a state re-read that failed after a successful save reported the save as failed.
 */
const fetchState = vi.fn<() => Promise<unknown>>()
const patchServer = vi.fn<() => Promise<unknown>>()
const serverAction = vi.fn<() => Promise<unknown>>()
vi.mock('@/lib/api', async original => ({
  ...await original<typeof import('../src/lib/api')>(),
  fetchState: () => fetchState(),
  patchServer: () => patchServer(),
  serverAction: () => serverAction(),
}))

beforeEach(() => {
  vi.resetModules()
  fetchState.mockReset()
  patchServer.mockReset()
  serverAction.mockReset()
})

describe('the stock control plane', () => {
  it('gives each caller its own result, whatever else failed meanwhile', async () => {
    fetchState.mockResolvedValue({ workspaces: [] })
    let releaseStart!: (error: Error) => void
    serverAction.mockReturnValue(new Promise((_, reject) => {
      releaseStart = reject
    }))
    patchServer.mockResolvedValue({ ok: true })
    const { useControlPlane } = await import('../src/composables/useControlPlane')
    const control = useControlPlane()

    const start = control.start('default', 'db')
    const save = control.saveConfig('default', 'web', { command: 'node' })
    releaseStart(new Error('port 5432 is held'))

    expect(await start).toEqual({ ok: false, error: 'port 5432 is held' })
    expect((await save).ok).toBe(true)
  })

  it('reports a save as saved when only the refresh after it failed', async () => {
    patchServer.mockResolvedValue({ ok: true })
    fetchState.mockRejectedValue(new Error('panel restarting'))
    const { useControlPlane } = await import('../src/composables/useControlPlane')
    const outcome = await useControlPlane().saveConfig('default', 'web', { command: 'node' })
    expect(outcome.ok).toBe(true)
  })
})
