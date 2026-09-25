import type { ControlView } from '@shared/contracts'
import type { FormSnapshots } from '../src/components/settings/settingsForm'
import { defaultsSchema } from '@shared/contracts'
import { countLeaves } from '@shared/patch-diff'
import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import {
  authBaseline,
  blockSnapshot,
  controlPatch,
  createSettingsForm,
  defaultsPatch,
  isBlockEdited,
  listenerBaseline,
  numberModel,
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
    // Only the auth flag is under test, so the view's label starts from the form's own
    // default instead of a copy of it that drifts whenever that default changes.
    const view = controlView(true)
    view.label = form.control.label

    expect(countLeaves(controlPatch(view, form) as Record<string, unknown>)).toBe(1)
    expect(controlPatch(view, form)).toEqual({ auth: { enabled: false } })
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
    const view = controlView(true)
    const form = createSettingsForm()
    const snapshots: FormSnapshots = {}

    // Never filled: the defaults differ from the config (`auth.enabled`), and
    // that must not be mistaken for an edit that blocks the first fill.
    expect(isBlockEdited(form, snapshots, 'control')).toBe(false)

    hydrate(form, view)
    snapshots.control = blockSnapshot(form, 'control')
    expect(isBlockEdited(form, snapshots, 'control')).toBe(false)

    form.auth.enabled = false
    expect(isBlockEdited(form, snapshots, 'control')).toBe(true)
  })

  /**
   * The reported bug: `/api/settings` lands after the state stream, so a guard
   * that looked at the whole form refused to fill the backups policy and the
   * toggle flipped back to the schema default on every reload.
   */
  it('fills each block on its own, whatever another block is doing', () => {
    const form = createSettingsForm()
    const snapshots: FormSnapshots = { backups: blockSnapshot(form, 'backups') }
    form.backups.enabled = false

    expect(isBlockEdited(form, snapshots, 'backups')).toBe(true)
    expect(isBlockEdited(form, snapshots, 'host')).toBe(false)
    expect(isBlockEdited(form, snapshots, 'control')).toBe(false)
  })
})

/**
 * The settings blocks store plain numbers and back their `NumberField`s with this,
 * so a number typed into one has to survive — and an emptied field has to land on
 * the fallback rather than `NaN`.
 */
describe('numberModel', () => {
  function model(initial: number, fallback: number) {
    let stored = initial
    const field = numberModel(() => stored, (value) => {
      stored = value
    }, fallback)
    return { field, get: () => stored }
  }

  it('stores a number the field reported', () => {
    const m = model(3999, 3999)
    m.field.value = 4123
    expect(m.get()).toBe(4123)
  })

  it('falls back when the field is emptied or left invalid', () => {
    const m = model(3999, 3999)
    m.field.value = null
    expect(m.get()).toBe(3999)
    m.field.value = Number.NaN
    expect(m.get()).toBe(3999)
  })

  it('reads the stored number back out', () => {
    const m = model(4321, 3999)
    expect(m.field.value).toBe(4321)
  })
})

/**
 * The health group is the one place a patch has an object to compare: comparing
 * its members by reference reported the whole group as changed on a form nobody
 * had touched, which is the "4 fields changed" phantom.
 */
describe('nested policy groups', () => {
  function liveDefaults() {
    const parsed = defaultsSchema({ health: { mode: 'http' } })
    if (parsed instanceof type.errors)
      throw new Error(parsed.summary)
    return parsed
  }

  it('reports nothing for an untouched group, object member included', () => {
    const live = liveDefaults()
    const form = {
      ...createSettingsForm().defaults,
      ...live,
      restart: { ...live.restart },
      health: { ...live.health, http: { ...live.health.http } },
      stop: { ...live.stop },
    }

    expect(defaultsPatch(live, form)).toEqual({})
  })

  it('reports the sub-key that changed', () => {
    const live = liveDefaults()
    const form = {
      ...createSettingsForm().defaults,
      ...live,
      restart: { ...live.restart },
      health: { ...live.health, intervalMs: 1234, http: { ...live.health.http } },
      stop: { ...live.stop },
    }

    expect(defaultsPatch(live, form)).toEqual({ health: { intervalMs: 1234 } })
  })
})
