import type { ControlView } from '@shared/contracts'
import type { GlobalSettingsForm, WorkspaceSettingsForm } from '../src/components/settings/settingsForm'
import { defaultsSchema } from '@shared/contracts'
import { countLeaves } from '@shared/patch-diff'
import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import {
  authBaseline,
  controlPartEdited,
  controlPatch,
  createGlobalForm,
  createWorkspaceForm,
  defaultsPatch,
  globalBlockSnapshot,
  isBlockEdited,
  listenerBaseline,
  numberModel,
  rememberControlPart,
  workspaceBlockSnapshot,
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
function hydrate(form: GlobalSettingsForm, view: ControlView): void {
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
    const form = createGlobalForm()
    // Only the auth flag is under test, so the view's label starts from the form's own
    // default instead of a copy of it that drifts whenever that default changes.
    const view = controlView(true)
    view.label = form.control.label

    expect(countLeaves(controlPatch(view, form) as Record<string, unknown>)).toBe(1)
    expect(controlPatch(view, form)).toEqual({ auth: { enabled: false } })
  })

  it('has nothing pending once the frame has filled the form', () => {
    const form = createGlobalForm()
    hydrate(form, controlView(true))

    expect(controlPatch(controlView(true), form)).toEqual({})
    expect(form.auth.enabled).toBe(true)
  })

  it('still offers the change when the user actually flips the toggle', () => {
    const form = createGlobalForm()
    hydrate(form, controlView(true))
    form.auth.enabled = false

    expect(controlPatch(controlView(true), form)).toEqual({ auth: { enabled: false } })
  })

  it('reports to the shell whether it may be overwritten', () => {
    const view = controlView(true)
    const form = createGlobalForm()

    // Never filled: the defaults differ from the config (`auth.enabled`), and
    // that must not be mistaken for an edit that blocks the first fill.
    expect(isBlockEdited(undefined, globalBlockSnapshot(form, 'control'))).toBe(false)

    hydrate(form, view)
    const snapshot = globalBlockSnapshot(form, 'control')
    expect(isBlockEdited(snapshot, globalBlockSnapshot(form, 'control'))).toBe(false)

    form.auth.enabled = false
    expect(isBlockEdited(snapshot, globalBlockSnapshot(form, 'control'))).toBe(true)
  })

  /**
   * The reported bug: `/api/settings` lands after the state stream, so a guard
   * that looked at the whole form refused to fill the backups policy and the
   * toggle flipped back to the schema default on every reload.
   */
  it('fills each block on its own, whatever another block is doing', () => {
    const form = createGlobalForm()
    const control = globalBlockSnapshot(form, 'control')
    const backups = globalBlockSnapshot(form, 'backups')
    form.backups.enabled = false

    expect(isBlockEdited(backups, globalBlockSnapshot(form, 'backups'))).toBe(true)
    expect(isBlockEdited(undefined, globalBlockSnapshot(form, 'host'))).toBe(false)
    expect(isBlockEdited(control, globalBlockSnapshot(form, 'control'))).toBe(false)
  })

  /**
   * The split behind the same rule: the per-workspace blocks (`defaults`, `logs`,
   * `telegram`) are filled and guarded independently of the panel-wide ones, so an
   * untouched workspace block must never look edited, and a global edit must not
   * leak into it.
   */
  it('guards the workspace blocks separately from the global ones', () => {
    const global = createGlobalForm()
    const workspace: WorkspaceSettingsForm = createWorkspaceForm()

    // Never filled: the defaults differ from what a live workspace would send, and
    // that must not be mistaken for an edit that blocks the first fill.
    expect(isBlockEdited(undefined, workspaceBlockSnapshot(workspace, 'defaults'))).toBe(false)

    // Filled from live state, then left alone: still not an edit.
    const defaults = workspaceBlockSnapshot(workspace, 'defaults')
    expect(isBlockEdited(defaults, workspaceBlockSnapshot(workspace, 'defaults'))).toBe(false)

    // A panel-wide edit leaves the workspace snapshots alone.
    global.backups.enabled = false
    expect(isBlockEdited(defaults, workspaceBlockSnapshot(workspace, 'defaults'))).toBe(false)
    expect(isBlockEdited(undefined, workspaceBlockSnapshot(workspace, 'logs'))).toBe(false)

    // Only the workspace block that was actually edited reports as edited.
    workspace.defaults.health.intervalMs = 1234
    expect(isBlockEdited(defaults, workspaceBlockSnapshot(workspace, 'defaults'))).toBe(true)
    expect(isBlockEdited(undefined, workspaceBlockSnapshot(workspace, 'logs'))).toBe(false)
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
 * had touched, which is the "4 fields changed" phantom. The same detachment is
 * what `workspaceBlockSnapshot` has to keep, or an edit to a nested member would
 * mutate the very snapshot the frame guard compares against (`cloneHealth`).
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
    const form: WorkspaceSettingsForm = createWorkspaceForm()
    form.defaults = {
      ...form.defaults,
      ...live,
      restart: { ...live.restart },
      health: { ...live.health, http: { ...live.health.http } },
      stop: { ...live.stop },
    }

    expect(defaultsPatch(live, form.defaults)).toEqual({})
  })

  it('reports the sub-key that changed', () => {
    const live = liveDefaults()
    const form: WorkspaceSettingsForm = createWorkspaceForm()
    form.defaults = {
      ...form.defaults,
      ...live,
      restart: { ...live.restart },
      health: { ...live.health, intervalMs: 1234, http: { ...live.health.http } },
      stop: { ...live.stop },
    }

    expect(defaultsPatch(live, form.defaults)).toEqual({ health: { intervalMs: 1234 } })
  })

  it('keeps a snapshot detached from the nested group it was taken from', () => {
    const form = createWorkspaceForm()
    const snapshot = workspaceBlockSnapshot(form, 'defaults') as { health: { http: { expectStatusBelow: number } } }

    form.defaults.health.http.expectStatusBelow = 500

    // A shallow copy would have aliased `http`, so the snapshot would have moved too.
    expect(snapshot.health.http.expectStatusBelow).toBe(400)
    expect(isBlockEdited(snapshot, workspaceBlockSnapshot(form, 'defaults'))).toBe(true)
  })
})

/**
 * Listeners, Authentication and TLS are one `control` block in the form but three groups on
 * screen, each with its own Reset. Snapshotting them together meant a Reset in one
 * re-baselined the others: rename the panel, then reset the session lifetime, and the next
 * state frame silently discarded the rename.
 */
describe('the control sub-groups', () => {
  it('keeps a pending listener edit when another group is reset', () => {
    const form = createGlobalForm()
    const snapshots: Record<string, unknown> = {}
    // The page has just filled from live state.
    for (const part of ['listener', 'auth', 'tls'] as const)
      rememberControlPart(form, snapshots, part)

    // The user renames the panel, then changes the session lifetime and presses its Reset.
    form.control.label = 'My panel'
    expect(controlPartEdited(form, snapshots.control, 'listener')).toBe(true)

    form.auth.sessionTtlMs = 123_456
    Object.assign(form.auth, authBaseline(controlView(true).auth))
    rememberControlPart(form, snapshots, 'auth')

    // The listener edit is still pending, so the next frame leaves it alone.
    expect(controlPartEdited(form, snapshots.control, 'listener')).toBe(true)
    expect(form.control.label).toBe('My panel')
    // …while the reset group is clean again.
    expect(controlPartEdited(form, snapshots.control, 'auth')).toBe(false)
  })

  it('does not report an untouched group as edited', () => {
    const form = createGlobalForm()
    const snapshots: Record<string, unknown> = {}
    for (const part of ['listener', 'auth', 'tls'] as const)
      rememberControlPart(form, snapshots, part)

    for (const part of ['listener', 'auth', 'tls'] as const)
      expect(controlPartEdited(form, snapshots.control, part), part).toBe(false)

    form.control.tlsEnabled = !form.control.tlsEnabled
    expect(controlPartEdited(form, snapshots.control, 'tls')).toBe(true)
    expect(controlPartEdited(form, snapshots.control, 'listener')).toBe(false)
    expect(controlPartEdited(form, snapshots.control, 'auth')).toBe(false)
  })
})

/**
 * The three-way `trustProxy` must survive the form ⇄ wire round trip.
 *
 * The form holds it as a string (a select cannot carry a boolean), while the wire form is
 * `boolean | 'loopback'`. Two conversions that disagree is exactly the bug this guards: converting only
 * `next` made the diff compare a string against a boolean, so **every save carried a spurious
 * `trustProxy`** — and a checkbox would have silently turned the safe `'loopback'` into `true`.
 */
describe('the three-way trustProxy', () => {
  const withProxy = (trustProxy: boolean | 'loopback') => ({
    enabled: true,
    passwordSet: true,
    passwordUpdatedAt: 1,
    apiTokenSet: false,
    usingDefaultPassword: false,
    sessionTtlMs: 604_800_000,
    cookieSecure: 'auto' as const,
    trustProxy,
    exposed: false,
    blockedReason: null,
    maxLoginAttempts: 5,
    lockoutMs: 60_000,
  })

  function viewFor(trustProxy: boolean | 'loopback') {
    const form = createGlobalForm()
    return {
      form,
      view: { label: form.control.label, port: form.control.port, host: form.control.host, openBrowser: false, auth: withProxy(trustProxy), tls: { enabled: false } } as never,
    }
  }

  it('sends nothing when the value is unchanged', () => {
    for (const value of [false, true, 'loopback'] as const) {
      const { form, view } = viewFor(value)
      Object.assign(form.auth, authBaseline(withProxy(value)))
      expect(controlPatch(view, form), `unchanged ${String(value)}`).toEqual({})
    }
  })

  it('sends the wire value the user picked', () => {
    const { form, view } = viewFor(false)
    Object.assign(form.auth, authBaseline(withProxy(false)))

    form.auth.trustProxy = 'loopback'
    expect(controlPatch(view, form)).toEqual({ auth: { trustProxy: 'loopback' } })

    form.auth.trustProxy = 'any'
    expect(controlPatch(view, form)).toEqual({ auth: { trustProxy: true } })
  })
})
