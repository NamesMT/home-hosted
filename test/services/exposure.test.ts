import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { checkExposure } from '#src/services/exposure'
import { authSchema, controlSchema } from '#src/shared/contracts'

function control(host: string, auth: Record<string, unknown> = {}) {
  const parsed = controlSchema({ host, auth })
  if (parsed instanceof type.errors)
    throw parsed
  return parsed
}

describe('control panel exposure', () => {
  it('treats loopback as safe, whatever the auth state', () => {
    for (const passwordSet of [true, false]) {
      const state = checkExposure(control('local'), passwordSet)
      expect(state.exposed).toBe(false)
      expect(state.blockedReason).toBeNull()
    }
  })

  it('blocks every non-loopback bind that lacks a password', () => {
    for (const host of ['lan', '0.0.0.0', '192.168.1.10']) {
      for (const auth of [{}, { enabled: true }, { enabled: false }]) {
        const state = checkExposure(control(host, auth), false)
        expect(state.exposed, host).toBe(true)
        expect(state.blockedReason, `${host} ${JSON.stringify(auth)}`).not.toBeNull()
      }
    }
  })

  it('blocks a non-loopback bind with a password when auth is switched off', () => {
    const state = checkExposure(control('lan', { enabled: false }), true)
    expect(state.exposed).toBe(true)
    expect(state.blockedReason).toContain('disabled')
  })

  it('allows a non-loopback bind when auth is on and armed', () => {
    const state = checkExposure(control('lan', { enabled: true }), true)
    expect(state).toEqual({ exposed: true, blockedReason: null })
  })

  it('names the missing piece in the reason', () => {
    expect(checkExposure(control('lan', { enabled: true }), false).blockedReason).toContain('no password')
    expect(checkExposure(control('lan', { enabled: false }), false).blockedReason).toContain('authentication is disabled')
  })

  it('defaults to a local bind with authentication on', () => {
    const parsed = controlSchema({})
    expect(parsed instanceof type.errors).toBe(false)
    if (parsed instanceof type.errors)
      return
    expect(parsed.host).toBe('local')
    expect(parsed.auth.enabled).toBe(true)
    expect(parsed.auth.sessionTtlMs).toBe(604800000)
    expect(parsed.tls.enabled).toBe(false)
  })

  it('blocks exposure while the default password is still in use', () => {
    const state = checkExposure(control('lan', { enabled: true }), true, true)
    expect(state.exposed).toBe(true)
    expect(state.blockedReason).toContain('default password')
  })

  it('rejects unknown auth keys', () => {
    expect(authSchema({ enabled: true, typo: 1 } as unknown) instanceof type.errors).toBe(true)
  })
})
