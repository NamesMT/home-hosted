import type { SessionView } from '@shared/contracts'
import { describe, expect, it } from 'vitest'
import { streamDecision } from '../src/composables/useSession'

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    authenticated: false,
    authRequired: false,
    passwordSet: true,
    usingDefaultPassword: false,
    defaultPassword: null,
    sessionTtlMs: 604_800_000,
    ...overrides,
  }
}

/**
 * The reported bug: the shell watched `authRequired`/`authenticated`, and with
 * authentication off both stay `false` from the first paint — the watch never ran
 * again after the session landed, so the event stream was never opened and the
 * dashboard sat on "Connecting" while showing a stale snapshot forever.
 */
describe('streamDecision', () => {
  it('waits for a session that is still loading', () => {
    expect(streamDecision(null)).toBe('wait')
  })

  it('connects on a panel that does not require authentication', () => {
    expect(streamDecision(session())).toBe('connect')
    expect(streamDecision(session({ passwordSet: false }))).toBe('connect')
  })

  it('connects for a signed-in session', () => {
    expect(streamDecision(session({ authRequired: true, authenticated: true }))).toBe('connect')
  })

  it('sends an unauthenticated visitor of a protected panel to the login view', () => {
    expect(streamDecision(session({ authRequired: true, authenticated: false }))).toBe('login')
  })

  it('is a decision, so the shell can watch it: the value changes when the session arrives', () => {
    expect(streamDecision(null)).not.toBe(streamDecision(session()))
  })
})
