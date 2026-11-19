import type { ControlView } from '@shared/contracts'
import { describe, expect, it } from 'vitest'
import {
  controlPartEdited,
  createGlobalForm,
  listenerBaseline,
  rememberControlPart,
  syncControlPart,
} from '../src/components/settings/settingsForm'

/**
 * The reported bug: turning **Serve the panel over HTTPS** on flipped back within a second.
 *
 * `ListenerForm` carries `tlsEnabled` because the `control` patch is one block, but the page guards
 * its three groups separately. While TLS was being edited the listener part was untouched, so the
 * listener fill ran and `Object.assign(form.control, listenerBaseline(view))` wrote the live
 * `tls.enabled` over the toggle — the same shape as the webhook-list revert, out of a baseline that
 * held a field its own guard did not cover.
 */

function controlView(enabled: boolean): ControlView {
  return {
    label: 'home-hosted',
    port: 3999,
    host: 'local',
    bindHost: '127.0.0.1',
    url: 'http://127.0.0.1:3999',
    protocol: 'http',
    openBrowser: false,
    restartRequired: false,
    allowedHosts: [],
    auth: {
      enabled: true,
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
      enabled,
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

/** A form filled the way the first state frame fills it. */
function hydrated() {
  const form = createGlobalForm()
  const snapshots: Record<string, unknown> = {}
  const view = controlView(false)
  for (const part of ['listener', 'auth', 'tls'] as const)
    syncControlPart(form, snapshots, view, part)
  return { form, snapshots }
}

/** One pass of the page's fill loop, as `GlobalSettingsView.syncFromLive()` runs it. */
function frame(form: ReturnType<typeof createGlobalForm>, snapshots: Record<string, unknown>, view: ControlView): void {
  for (const part of ['listener', 'auth', 'tls'] as const)
    syncControlPart(form, snapshots, view, part)
}

describe('the TLS toggle survives a live frame', () => {
  it('does not carry the saved TLS flag in the listener baseline at all', () => {
    // A part's baseline carries exactly what that part's own guard covers: the listener fill runs
    // while TLS is mid-edit, so any field it assigns is a revert.
    expect(Object.keys(listenerBaseline(controlView(true)))).not.toContain('tlsEnabled')
  })

  it('keeps the pending TLS edit when the listener part fills', () => {
    const { form, snapshots } = hydrated()

    form.control.tlsEnabled = true
    expect(controlPartEdited(form, snapshots.control, 'tls')).toBe(true)

    // The next state frame still carries what the panel holds, which is "off" until the save.
    frame(form, snapshots, controlView(false))

    expect(form.control.tlsEnabled, 'the live frame reverted the toggle').toBe(true)
  })

  it('still follows a listener change made elsewhere', () => {
    const { form, snapshots } = hydrated()

    // A pending TLS edit must not stop the listener following a rename made in another tab.
    form.control.tlsEnabled = true
    frame(form, snapshots, { ...controlView(false), label: 'Renamed', port: 4100 })

    expect(form.control.label).toBe('Renamed')
    expect(form.control.port).toBe(4100)
    expect(form.control.tlsEnabled).toBe(true)
  })

  it('follows the TLS flag again once the save has dropped the snapshots', () => {
    const { form, snapshots } = hydrated()

    form.control.tlsEnabled = true
    frame(form, snapshots, controlView(false))
    expect(form.control.tlsEnabled).toBe(true)

    // After a save the page forgets its snapshots; from then on live state is the truth.
    delete snapshots.control
    form.control.tlsEnabled = false
    frame(form, snapshots, controlView(true))

    expect(form.control.tlsEnabled).toBe(true)
    expect(controlPartEdited(form, snapshots.control, 'tls')).toBe(false)
  })

  it('reports the one pending field, not the whole group', () => {
    const { form, snapshots } = hydrated()
    form.control.tlsEnabled = true
    rememberControlPart(form, snapshots, 'listener')

    // Only TLS is edited; the listener fields are untouched, so their group is clean.
    expect(controlPartEdited(form, snapshots.control, 'listener')).toBe(false)
    expect(controlPartEdited(form, snapshots.control, 'tls')).toBe(true)
  })
})
