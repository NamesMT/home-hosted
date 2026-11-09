import type { SessionView } from '@shared/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The live view froze after a panel restart when a password was set: sessions are in memory, so the
 * browser's reconnect got 401 and an EventSource stops retrying on any non-200. The stream now asks
 * the panel who is signed in — signed out goes to the login view, anything else reconnects.
 */
const fetchSession = vi.fn<() => Promise<SessionView>>()
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('../src/lib/api')>(), fetchSession: () => fetchSession() }))

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(): void {}
  close(): void {
    this.readyState = 2
  }
}

function session(authenticated: boolean): SessionView {
  return { authenticated, authRequired: true, passwordSet: true, usingDefaultPassword: false, defaultPassword: null, sessionTtlMs: 1 } as SessionView
}

beforeEach(() => {
  vi.resetModules()
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function giveUp() {
  const { connect, disconnect } = await import('../src/composables/useControlPlane')
  const { useSession } = await import('../src/composables/useSession')
  connect()
  const source = FakeEventSource.instances.at(-1)!
  source.readyState = 2
  source.onerror?.()
  await vi.advanceTimersByTimeAsync(1000)
  return { disconnect, session: useSession().session }
}

describe('the stock stream after the browser gives up', () => {
  it('routes a signed-out session to the login view instead of retrying', async () => {
    fetchSession.mockResolvedValue(session(false))
    const { session: current, disconnect } = await giveUp()
    expect(current.value).toMatchObject({ authRequired: true, authenticated: false })
    expect(FakeEventSource.instances).toHaveLength(1)
    disconnect()
  })

  it('reconnects while the session is still good', async () => {
    fetchSession.mockResolvedValue(session(true))
    const { disconnect } = await giveUp()
    expect(FakeEventSource.instances).toHaveLength(2)
    disconnect()
  })
})
