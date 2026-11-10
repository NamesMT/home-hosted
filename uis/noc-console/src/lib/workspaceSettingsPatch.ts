import type { DestinationStatusView, LogsConfig, NotificationView, ServerDefaults, WorkspaceSettingsPatch } from '@shared/contracts'
import type { Patch } from '@shared/patch-diff'
import { repairNumbers } from '@shared/form-repair'
import { diffFields, mergeReplacedList, patchSinceFilled } from '@shared/patch-diff'

/**
 * The workspace-scoped settings patch, out of the view that used to own it.
 *
 * `SettingsView.vue` carried this as `buildWorkspacePatch`, next to the page's own fill/snapshot
 * machinery — so the rule that decides what a workspace save writes could only be exercised by
 * mounting a 1000-line route. It lives here for the same reason its global sibling does: a rule
 * about a config is not a rule about a layout. Everything below is pure; the view hands in its form
 * and its snapshots.
 */

/** The general notification block as the page edits it. */
export interface PolicyDraft {
  onCrash: boolean
  onUnhealthy: boolean
  onForcedRestart: boolean
  onRecovered: boolean
  onHost: boolean
  onDdns: boolean
  cooldownMs: number
}

/** One destination as the config carries it: the status row minus its derived fields. */
export type DestinationDraft = Omit<DestinationStatusView, 'lastResult' | 'lastResultAt'>

/** Server defaults as the page edits them: the three lifecycle groups live as typed objects. */
export interface DefaultsForm {
  enabled: boolean
  autostart: boolean
  bind: ServerDefaults['bind']
  onPortConflict: ServerDefaults['onPortConflict']
  logBufferLines: number
  restart: ServerDefaults['restart']
  health: ServerDefaults['health']
  stop: ServerDefaults['stop']
}

export interface LogsForm {
  persist: boolean
  maxBytes: number
  keep: number
}

export interface NotificationsForm {
  policy: PolicyDraft
  destinations: DestinationDraft[]
}

export interface WorkspaceSettingsForm {
  defaults: DefaultsForm
  logs: LogsForm
  notifications: NotificationsForm
}

/** What each block held when the page last filled it; absent means "never filled". */
export type WorkspaceFormSnapshots = Partial<Record<'defaults' | 'logs' | 'notifications', unknown>>

/** A copy of the health group, nested `http` included. */
export function cloneHealth(health: ServerDefaults['health']): ServerDefaults['health'] {
  return { ...health, http: { ...health.http } }
}

/** The general block as the form holds it. */
export function policyConfig(status: Omit<PolicyDraft, 'onDdns'> & { onDdns?: boolean }): PolicyDraft {
  return {
    onCrash: status.onCrash,
    onUnhealthy: status.onUnhealthy,
    onForcedRestart: status.onForcedRestart,
    onRecovered: status.onRecovered,
    onHost: status.onHost,
    // A panel from before DDNS sends no flag; absent means "on".
    onDdns: status.onDdns !== false,
    cooldownMs: status.cooldownMs,
  }
}

/**
 * One destination in the shape the API *stores* — the only shape a diff may compare.
 *
 * `tokenSet` is derived and never written, so it must not appear on either side of the diff; the
 * policy columns are written only for a destination that carries its own. Comparing the form's
 * richer shape against the wire shape made every untouched row look edited, so the change dialog
 * always claimed an edit and a save rewrote the list in its reduced form.
 */
export function destinationWire(entry: DestinationDraft): Record<string, unknown> {
  return {
    kind: entry.kind,
    id: entry.id,
    enabled: entry.enabled,
    useOwnSettings: entry.useOwnSettings,
    ...(entry.kind === 'telegram' ? { chatId: entry.chatId } : { url: entry.url, method: entry.method, format: entry.format, headers: entry.headers }),
    ...(entry.useOwnSettings
      ? { onCrash: entry.onCrash, onUnhealthy: entry.onUnhealthy, onForcedRestart: entry.onForcedRestart, onRecovered: entry.onRecovered, onHost: entry.onHost, onDdns: entry.onDdns, cooldownMs: entry.cooldownMs }
      : {}),
  }
}

/** One destination as the form holds it, with the view's nullable columns resolved. */
export function destinationConfig(row: DestinationStatusView): DestinationDraft {
  return {
    id: row.id,
    kind: row.kind,
    enabled: row.enabled,
    useOwnSettings: row.useOwnSettings,
    chatId: row.chatId ?? '',
    tokenSet: row.tokenSet,
    url: row.url ?? '',
    method: row.method ?? 'POST',
    format: row.format ?? 'json',
    headers: row.headers ?? '',
    ...policyConfig(row),
  }
}

/**
 * The destination list this block was filled with, or `undefined` when it never was.
 *
 * A replaced list is all-or-nothing on the wire, so what decides "send it" is this baseline — the
 * only record of which entries the form has seen, and so of which absences are its deletions.
 */
export function filledDestinations(snapshot: unknown): DestinationDraft[] | undefined {
  if (snapshot === null || typeof snapshot !== 'object')
    return undefined
  const destinations = (snapshot as { destinations?: unknown }).destinations
  return Array.isArray(destinations) ? (destinations as DestinationDraft[]) : undefined
}

/**
 * An emptied number box reports `''`, which the patch schema rejects for the whole body. Put the
 * live value back first, so the field drops out of the diff instead of failing the save.
 */
export function repairWorkspaceForm(form: WorkspaceSettingsForm, defaults: ServerDefaults, live: { logs: LogsConfig, notifications: NotificationView } | null): void {
  repairNumbers(form.defaults as unknown as Record<string, unknown>, defaults as unknown as Record<string, unknown>)
  if (live === null)
    return
  repairNumbers(form.logs as unknown as Record<string, unknown>, live.logs as unknown as Record<string, unknown>)
  repairNumbers(
    form.notifications.policy as unknown as Record<string, unknown>,
    (live.notifications.defaults ?? form.notifications.policy) as unknown as Record<string, unknown>,
  )
}

export interface WorkspacePatchInput {
  form: WorkspaceSettingsForm
  defaults: ServerDefaults
  /** The live workspace view, or null before the first frame. */
  live: { logs: LogsConfig, notifications: NotificationView } | null
  snapshots: WorkspaceFormSnapshots
}

/**
 * What a workspace save writes: the form minus everything equal to what it was **filled** with.
 *
 * Diffing against live state instead would treat another client's change as this form's own and
 * write the old value back over it.
 */
export function buildWorkspacePatch(input: WorkspacePatchInput): WorkspaceSettingsPatch {
  const { form, defaults, live, snapshots } = input
  const patch: WorkspaceSettingsPatch = {}

  const defaultsPatch = patchSinceFilled(
    defaults as unknown as Patch,
    snapshots.defaults as Patch | undefined,
    { ...form.defaults } as unknown as Patch,
    ['restart', 'health', 'stop'],
  )
  if (Object.keys(defaultsPatch).length > 0)
    patch.defaults = defaultsPatch as WorkspaceSettingsPatch['defaults']

  if (live !== null) {
    const logsPatch = patchSinceFilled(live.logs as unknown as Patch, snapshots.logs as Patch | undefined, { ...form.logs } as unknown as Patch)
    if (Object.keys(logsPatch).length > 0)
      patch.logs = logsPatch as WorkspaceSettingsPatch['logs']

    // The general block merges; the list is **replaced** — a merge cannot express removing one.
    // An inheriting destination sends no policy columns: they would be ignored anyway, and writing
    // them would make the config say something the page does not mean.
    const notificationsPatch = diffFields(
      { defaults: policyConfig(live.notifications.defaults ?? form.notifications.policy) } as unknown as Patch,
      { defaults: { ...form.notifications.policy } } as unknown as Patch,
      ['defaults'],
    )
    // The list is all-or-nothing on the wire, so it travels only when *this form* changed it, and
    // merged against what it was filled with — sending the draft alone deletes a destination another
    // client added while the page was open.
    const filled = filledDestinations(snapshots.notifications)
    const destinations = mergeReplacedList({
      filled,
      draft: form.notifications.destinations,
      live: (live.notifications.destinations ?? []).map(destinationConfig),
      key: entry => entry.id,
    })
    if (destinations !== null)
      notificationsPatch.destinations = destinations.map(destinationWire)
    if (Object.keys(notificationsPatch).length > 0)
      patch.notifications = notificationsPatch as WorkspaceSettingsPatch['notifications']
  }

  return patch
}
