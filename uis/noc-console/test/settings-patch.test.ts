import type { AuthStatus, BackupsView, ControlView } from '@shared/contracts'
import { describe, expect, it } from 'vitest'
import { authConfig, buildGlobalPatch, repairGlobalForm, toWireTrustProxy } from '../src/lib/settingsPatch'

/**
 * The panel-wide settings patch, which used to live inside a 1496-line view.
 *
 * `buildGlobalPatch` decides what a Save writes, and nothing exercised it: the view reads its
 * settings from a composable rather than a prop, so mounting the page was the only route in — and no
 * test mounted it. Two of the bugs below were found by writing these tests, not by reading the code:
 * an edited block writing another client's change back, and a cleared box refusing the whole body.
 */

/** A control view with only the fields the patch reads. */
function controlView(overrides: Partial<ControlView> = {}): ControlView {
  return {
    label: 'home-hosted',
    port: 3999,
    host: 'local',
    bindHost: '127.0.0.1',
    url: 'http://127.0.0.1:3999',
    openBrowser: false,
    allowedHosts: [],
    restartRequired: false,
    protocol: 'http',
    auth: {
      enabled: false,
      passwordSet: true,
      passwordUpdatedAt: 1,
      sessionTtlMs: 604_800_000,
      cookieSecure: 'auto',
      trustProxy: false,
      maxLoginAttempts: 5,
      lockoutMs: 60_000,
      exposed: false,
      usingDefaultPassword: false,
      blockedReason: null,
      apiTokenSet: false,
    },
    tls: { enabled: false, state: 'none', message: null },
    ...overrides,
  } as ControlView
}

/** The `auth` status the view hands to `authConfig`. */
function authStatus(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return { ...controlView().auth, ...overrides } as AuthStatus
}

function hostConfig() {
  return {
    enabled: true,
    intervalMs: 15_000,
    diskPaths: ['.'],
    diskUsedPercent: 90,
    memoryUsedPercent: 90,
    swapUsedPercent: 50,
    loadPerCpu: 2,
    tempCelsius: 85,
    tempCommand: '',
    tempCommandTimeoutMs: 5000,
  }
}

function backupsView(overrides: Partial<BackupsView> = {}): BackupsView {
  return {
    enabled: true,
    dir: '.backups',
    keep: 5,
    includePaths: [],
    files: [],
    schedule: { intervalMs: 0, keep: 7 },
    ...overrides,
  } as BackupsView
}

/** The form as the page holds it after being filled from `view`. */
function formFrom(view: ControlView, backups = backupsView()) {
  return {
    control: {
      label: view.label,
      port: view.port,
      host: view.host,
      openBrowser: view.openBrowser,
      allowedHosts: (view.allowedHosts ?? []).join(', '),
      tlsEnabled: view.tls.enabled,
    },
    auth: authConfig(view.auth),
    host: { ...hostConfig(), diskPaths: '.' },
    backups: {
      enabled: backups.enabled,
      keep: backups.keep,
      includePaths: backups.includePaths.join(', '),
      scheduleEnabled: (backups.schedule?.intervalMs ?? 0) > 0,
      scheduleHours: Math.round((backups.schedule?.intervalMs ?? 0) / 3_600_000),
      scheduleKeep: backups.schedule?.keep ?? 7,
      scheduleScope: backups.schedule?.scope ?? null,
    },
  }
}

describe('toWireTrustProxy', () => {
  it('reads each of the three states', () => {
    // The select holds a string; the wire holds `boolean | 'loopback'`. Comparing the two shapes
    // without translating reported a change nobody made on every save.
    expect(toWireTrustProxy('any')).toBe(true)
    expect(toWireTrustProxy('off')).toBe(false)
    expect(toWireTrustProxy('loopback')).toBe('loopback')
    // A status already in wire form passes through unchanged.
    expect(toWireTrustProxy(true)).toBe(true)
    expect(toWireTrustProxy(false)).toBe(false)
  })
})

describe('authConfig', () => {
  it('turns the wire trustProxy into the three-way the select binds', () => {
    expect(authConfig(authStatus({ trustProxy: true })).trustProxy).toBe('any')
    expect(authConfig(authStatus({ trustProxy: false })).trustProxy).toBe('off')
    expect(authConfig(authStatus({ trustProxy: 'loopback' })).trustProxy).toBe('loopback')
  })

  it('carries only the fields the form edits', () => {
    // `passwordSet`, `updatedAt` and the rest are derived: putting one in the form makes the diff
    // see a field no box can clear.
    const form = authConfig(authStatus())
    expect(Object.keys(form).sort()).toEqual([
      'cookieSecure',
      'enabled',
      'lockoutMs',
      'maxLoginAttempts',
      'sessionTtlMs',
      'trustProxy',
    ])
  })
})

describe('an untouched form', () => {
  it('writes nothing', () => {
    const view = controlView()
    const backups = backupsView()
    const patch = buildGlobalPatch({
      form: formFrom(view, backups),
      view,
      configured: { host: hostConfig(), backups },
      // Filled from live state and never edited.
      snapshots: {
        control: formFrom(view, backups).control,
        auth: formFrom(view, backups).auth,
        host: formFrom(view, backups).host,
        backups: formFrom(view, backups).backups,
      },
    })
    expect(patch).toEqual({})
  })
})

describe('an edited block', () => {
  it('sends only the field that changed', () => {
    const view = controlView()
    const backups = backupsView()
    const form = formFrom(view, backups)
    form.control.label = 'renamed here'

    const patch = buildGlobalPatch({
      form,
      view,
      configured: { host: hostConfig(), backups },
      snapshots: {
        control: formFrom(view, backups).control,
        auth: formFrom(view, backups).auth,
        host: formFrom(view, backups).host,
        backups: formFrom(view, backups).backups,
      },
    })
    expect(patch.control).toEqual({ label: 'renamed here' })
  })

  it('does not write back another client\'s change to a block it left alone', () => {
    // The page was filled when `allowedHosts` was empty; another tab added a host; this save must not
    // remove it. Diffing against *live* state instead of the snapshot is exactly how that happened.
    const filled = controlView({ allowedHosts: [] })
    const live = controlView({ allowedHosts: ['panel.example.com'] })
    const backups = backupsView()
    const form = formFrom(filled, backups)
    form.control.label = 'renamed here'

    const patch = buildGlobalPatch({
      form,
      view: live,
      configured: { host: hostConfig(), backups },
      snapshots: { control: formFrom(filled, backups).control, auth: formFrom(filled, backups).auth },
    })
    expect(patch.control).toEqual({ label: 'renamed here' })
    // The host the other client added is untouched, and not re-sent as a removal.
    expect(patch.control).not.toHaveProperty('allowedHosts')
  })
})

describe('a cleared number box', () => {
  it('falls back to the live value instead of refusing the whole body', () => {
    // A cleared `<input type="number">` reports `''`; the patch schema rejects a string for the
    // whole body, which took every other pending edit with it. `repairGlobalForm` puts the live
    // value back, so the field simply drops out of the diff.
    const view = controlView()
    const backups = backupsView()
    const form = formFrom(view, backups)
    // What the box writes when someone clears it to retype.
    ;(form.host as unknown as Record<string, unknown>).loadPerCpu = ''

    repairGlobalForm(form, view, hostConfig(), backups)
    expect(form.host.loadPerCpu).toBe(2)

    const patch = buildGlobalPatch({
      form,
      view,
      configured: { host: hostConfig(), backups },
      snapshots: {},
    })
    // A repaired field equals what was filled, so it is not a change.
    expect(patch.host).toBeUndefined()
  })
})

describe('the schedule', () => {
  it('sends an interval when the hours box changes on an enabled schedule', () => {
    const view = controlView()
    // A schedule that is on, so the hours box is the field that means something.
    const backups = backupsView({ schedule: { intervalMs: 3_600_000, keep: 7 } })
    const filled = formFrom(view, backups)
    const form = formFrom(view, backups)
    form.backups.scheduleHours = 6

    const patch = buildGlobalPatch({
      form,
      view,
      configured: { host: hostConfig(), backups },
      snapshots: { backups: filled.backups },
    })
    expect(patch.backups).toMatchObject({ schedule: { intervalMs: 21_600_000 } })
  })

  it('sends nothing when the hours change while the schedule is off', () => {
    // The switch and the hour count are one stored field (`intervalMs`), so editing hours on an off
    // schedule decides nothing: `0` is the file's spelling for off either way.
    const view = controlView()
    const backups = backupsView()
    const filled = formFrom(view, backups)
    const form = formFrom(view, backups)
    form.backups.scheduleHours = 6

    const patch = buildGlobalPatch({
      form,
      view,
      configured: { host: hostConfig(), backups },
      snapshots: { backups: filled.backups },
    })
    expect(patch.backups).toBeUndefined()
  })
})
