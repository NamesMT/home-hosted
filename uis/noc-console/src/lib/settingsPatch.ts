import type { AuthStatus, BackupScope, BackupsView, ControlView, HostConfig, SettingsPatch } from '@shared/contracts'
import type { Patch } from '@shared/patch-diff'
import { linesToArray } from '@shared/fields'
import { repairNumbers } from '@shared/form-repair'
import { diffFields, patchSinceFilled } from '@shared/patch-diff'
import { schedulePatch } from '@/lib/backupSelection'

/**
 * The panel-wide settings patch, out of the view that used to own it.
 *
 * `GlobalSettingsView.vue` carried this as `buildGlobalPatch`, 111 lines inside a 1496-line
 * component — so the one piece of the page that decides *what a save writes* could only be
 * exercised by mounting the whole page, and nothing mounted it. It lives here for the same reason
 * `describeScope`/`schedulePatch` already do: a rule about a config is not a rule about a layout.
 *
 * Everything here is pure. The view keeps its `reactive` form and its snapshots and hands them in.
 */

/** The listener block as the page edits it. */
export interface ControlForm {
  label: string
  port: number
  host: string
  openBrowser: boolean
  allowedHosts: string
  tlsEnabled: boolean
}

/** Authentication as a form: the three-way proxy choice is a string, as `cookieSecure` already is. */
export interface AuthForm {
  enabled: boolean
  sessionTtlMs: number
  cookieSecure: AuthStatus['cookieSecure']
  trustProxy: boolean | 'loopback' | 'off' | 'any' | string
  maxLoginAttempts: number
  lockoutMs: number
}

/** Host vitals as the page edits them: `diskPaths` is a comma list and the rest are numbers. */
export interface HostForm {
  enabled: boolean
  intervalMs: number
  diskPaths: string
  diskUsedPercent: number
  memoryUsedPercent: number
  swapUsedPercent: number
  loadPerCpu: number
  tempCelsius: number
  tempCommand: string
  tempCommandTimeoutMs: number
}

/** Backups as the page edits them: the schedule is two boxes and a scope, not an interval. */
export interface BackupsForm {
  enabled: boolean
  keep: number
  includePaths: string
  scheduleEnabled: boolean
  scheduleHours: number
  scheduleKeep: number
  /** `null` is the whole default scope — what an untouched schedule has always captured. */
  scheduleScope: BackupScope | null
}

export interface GlobalSettingsForm {
  control: ControlForm
  auth: AuthForm
  host: HostForm
  backups: BackupsForm
}

/**
 * What each block held when the page last filled it from live state.
 *
 * Absent means "never filled": a block that was never filled is always free to refill, because the
 * form's own starting values differ from a real config (`auth.enabled`, `backups.enabled`) and would
 * otherwise read as a pending edit that blocks its own first fill.
 */
export type GlobalFormSnapshots = Partial<Record<keyof GlobalSettingsForm, unknown>>

/** A comma list as the stored string array. */
function splitList(value: string): string[] {
  return value.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
}

/**
 * The wire value of the three-way proxy choice, from either side.
 *
 * One definition, so a diff cannot compare a form's `'any'` against a wire `true` and report a
 * change nobody made.
 */
export function toWireTrustProxy(value: AuthForm['trustProxy']): boolean | 'loopback' {
  if (value === 'loopback')
    return 'loopback'
  return value === 'any' || value === true
}

/** Only the config-facing fields of the auth status; the rest is derived. */
export function authConfig(status: AuthStatus): AuthForm {
  return {
    enabled: status.enabled,
    sessionTtlMs: status.sessionTtlMs,
    cookieSecure: status.cookieSecure,
    // Held as a three-way string for the select, the shape `cookieSecure` already uses.
    trustProxy: status.trustProxy === 'loopback' ? 'loopback' : status.trustProxy ? 'any' : 'off',
    maxLoginAttempts: status.maxLoginAttempts,
    lockoutMs: status.lockoutMs,
  }
}

/** The control block and its `auth` sub-group in the shape a patch carries. */
function controlWire(control: ControlForm, auth: AuthForm): Patch {
  return {
    label: control.label,
    port: control.port,
    host: control.host,
    openBrowser: control.openBrowser,
    allowedHosts: linesToArray(control.allowedHosts),
    tls: { enabled: control.tlsEnabled },
    // The select holds the three-way choice as a string; the wire form is `boolean | 'loopback'`.
    auth: { ...auth, trustProxy: toWireTrustProxy(auth.trustProxy) },
  }
}

/**
 * An emptied number box reports `''`, which the patch schema rejects for the whole body — taking
 * every other pending edit with it. Writing the live value back first means the field simply drops
 * out of the diff. This is the same repair the server form does, from `@shared/form-repair`.
 */
export function repairGlobalForm(form: GlobalSettingsForm, view: ControlView, host: HostConfig, backups: BackupsView): void {
  repairNumbers(form.control as unknown as Record<string, unknown>, view as unknown as Record<string, unknown>)
  repairNumbers(form.host as unknown as Record<string, unknown>, host as unknown as Record<string, unknown>)
  repairNumbers(form.backups as unknown as Record<string, unknown>, backups as unknown as Record<string, unknown>)
  repairNumbers(form.auth as unknown as Record<string, unknown>, authConfig(view.auth) as unknown as Record<string, unknown>)
}

/**
 * What a save writes: the form minus everything equal to what it was **filled** with.
 *
 * Diffing against live state instead would treat another client's change as this form's own and
 * write the old value back over it — a hostname added to `allowedHosts` in another tab was removed
 * by a save made here.
 */
export function buildGlobalPatch(input: {
  form: GlobalSettingsForm
  view: ControlView
  configured: { host: HostConfig, backups: BackupsView } | null
  snapshots: GlobalFormSnapshots
}): SettingsPatch {
  const { form, view, configured, snapshots } = input
  const patch: SettingsPatch = {}

  const filledControl = snapshots.control as ControlForm | undefined
  const filledAuth = snapshots.auth as AuthForm | undefined
  const controlPatch = patchSinceFilled(
    {
      label: view.label,
      port: view.port,
      host: view.host,
      openBrowser: view.openBrowser,
      allowedHosts: view.allowedHosts ?? [],
      tls: { enabled: view.tls.enabled },
      // The wire shape, matching `next` below. `authConfig` returns the *form* shape, for hydrating.
      auth: { ...authConfig(view.auth), trustProxy: toWireTrustProxy(view.auth.trustProxy) },
    },
    filledControl === undefined && filledAuth === undefined
      ? undefined
      : controlWire(
          filledControl ?? {
            ...form.control,
            label: view.label,
            port: view.port,
            host: view.host,
            openBrowser: view.openBrowser,
            allowedHosts: (view.allowedHosts ?? []).join('\n'),
            tlsEnabled: view.tls.enabled,
          },
          filledAuth ?? authConfig(view.auth),
        ),
    controlWire(form.control, form.auth),
    ['auth'],
  )
  if (Object.keys(controlPatch).length > 0)
    patch.control = controlPatch as SettingsPatch['control']

  if (configured !== null) {
    const filledHost = snapshots.host as HostForm | undefined
    const hostPatch = patchSinceFilled(
      { ...configured.host, diskPaths: configured.host.diskPaths } as unknown as Patch,
      filledHost === undefined ? undefined : { ...filledHost, diskPaths: splitList(filledHost.diskPaths) } as unknown as Patch,
      { ...form.host, diskPaths: splitList(form.host.diskPaths) } as unknown as Patch,
    )
    if (Object.keys(hostPatch).length > 0)
      patch.host = hostPatch as SettingsPatch['host']

    // Only the members that actually changed: the hours box is a rounded view of `intervalMs`, and a
    // scope the dialog did not touch must not be re-sent. Both rules live beside the capture ones,
    // in `backupSelection.ts`, where they are tested without mounting a view.
    const filledBackups = snapshots.backups as BackupsForm | undefined
    const ownSchedule = schedulePatch(
      filledBackups === undefined
        ? configured.backups.schedule
        : {
            intervalMs: filledBackups.scheduleEnabled ? filledBackups.scheduleHours * 3_600_000 : 0,
            keep: filledBackups.scheduleKeep,
            ...(filledBackups.scheduleScope === null ? {} : { scope: filledBackups.scheduleScope }),
          },
      {
        enabled: form.backups.scheduleEnabled,
        hours: form.backups.scheduleHours,
        keep: form.backups.scheduleKeep,
        scope: form.backups.scheduleScope,
      },
    )

    const liveBackups = configured.backups as unknown as Patch
    const backupsPatch = {
      ...patchSinceFilled(
        liveBackups,
        filledBackups === undefined
          ? undefined
          : { enabled: filledBackups.enabled, keep: filledBackups.keep, includePaths: splitList(filledBackups.includePaths) },
        { enabled: form.backups.enabled, keep: form.backups.keep, includePaths: splitList(form.backups.includePaths) },
      ),
      ...diffFields(liveBackups, { schedule: ownSchedule }, ['schedule']),
    }
    if (Object.keys(backupsPatch).length > 0)
      patch.backups = backupsPatch as SettingsPatch['backups']
  }

  return patch
}
