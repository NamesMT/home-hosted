import type { ControlView } from '@shared/contracts'
import { describe, expect, it } from 'vitest'
import {
  authBaseline,
  controlPatch,
  countLeaves,
  createSettingsForm,
  listenerBaseline,
  shouldHydrate,
} from '../src/components/settings/settingsForm'

/** A control view as the state frame carries it; only `auth.enabled` varies here. */
function controlView(enabled: boolean): ControlView {
  return {
    label: 'Stock UI',
    port: 3999,
    host: 'local',
    bindHost: '127.0.0.1',
    url: 'http://127.0.0.1:3999',
    protocol: 'http',
    openBrowser: false,
    restartRequired: false,
    auth: {
      enabled,
      passwordSet: true,
      passwordUpdatedAt: 1,
      apiTokenSet: false,
      usingDefaultPassword: false,
      exposed: false,
      blockedReason: null,
      sessionTtlMs: 604_800_000,
      cookieSecure: 'auto',
      trustProxy: false,
      maxLoginAttempts: 5,
      lockoutMs: 60_000,
    },
    tls: {
      enabled: false,
      certPresent: false,
      subject: null,
      issuer: null,
      validFrom: null,
      validTo: null,
      daysRemaining: null,
      fingerprint: null,
      keyMatches: null,
      error: null,
    },
  }
}

/** Fills the form the way `syncFromLive()` does once a frame has arrived. */
function hydrate(form: ReturnType<typeof createSettingsForm>, view: ControlView): void {
  Object.assign(form.control, listenerBaseline(view))
  Object.assign(form.auth, authBaseline(view.auth))
}

describe('settings form versus the live config', () => {
  /**
   * The reported bug: `auth.enabled` defaults to `true` in the config and to
   * `false` in the form, so an un-hydrated form already looks like a pending
   * edit — the page showed the toggle off and claimed one field had changed.
   */
  it('shows the mismatch an un-hydrated form would offer to revert', () => {
    const form = createSettingsForm()

    expect(countLeaves(controlPatch(controlView(true), form) as Record<string, unknown>)).toBe(1)
    expect(controlPatch(controlView(true), form)).toEqual({ auth: { enabled: false } })
  })

  it('has nothing pending once the frame has filled the form', () => {
    const form = createSettingsForm()
    hydrate(form, controlView(true))

    expect(controlPatch(controlView(true), form)).toEqual({})
    expect(form.auth.enabled).toBe(true)
  })

  it('still offers the change when the user actually flips the toggle', () => {
    const form = createSettingsForm()
    hydrate(form, controlView(true))
    form.auth.enabled = false

    expect(controlPatch(controlView(true), form)).toEqual({ auth: { enabled: false } })
  })

  it('reports to the shell whether it may be overwritten', () => {
    // No frame yet: nothing to fill from.
    expect(shouldHydrate({ hydrated: false, liveAvailable: false, changedCount: 0 })).toBe(false)
    // First frame, and the defaults differ: the form must still be filled.
    expect(shouldHydrate({ hydrated: false, liveAvailable: true, changedCount: 1 })).toBe(true)
    expect(shouldHydrate({ hydrated: true, liveAvailable: true, changedCount: 0 })).toBe(true)
    expect(shouldHydrate({ hydrated: true, liveAvailable: true, changedCount: 2 })).toBe(false)
  })
})
