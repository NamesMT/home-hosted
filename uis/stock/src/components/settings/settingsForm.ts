import type {
  AuthStatus,
  BackupScheduleConfig,
  BackupScope,
  BackupsView,
  ControlView,
  DestinationStatusView,
  HealthConfig,
  HostConfig,
  LogsConfig,
  NotificationDefaults,
  OnPortConflict,
  RestartConfig,
  ServerDefaults,
  StopConfig,
} from '@shared/contracts'
import type { Patch } from '@shared/patch-diff'
import type { WritableComputedRef } from 'vue'
import { sameScope } from '@shared/backup-scope'
import { countLeaves, diffFields, mergeReplacedList } from '@shared/patch-diff'
import { computed } from 'vue'
import { t } from '@/i18n'
import { waitForEndpoint } from '@/lib/endpoint'

/**
 * Editable form shapes for the settings the panel actually writes, split the way
 * the API is: the panel-wide blocks (listener, auth, host vitals, backups) and the
 * per-workspace blocks (server defaults, logs, notifications). Everything is
 * derived from live state, so the form is a plain, independent copy: an SSE frame
 * must never edit it.
 */

export interface ListenerForm {
  /** The panel's own name, edited from the Interface section. */
  label: string
  port: number
  host: string
  openBrowser: boolean
  /** Part of the `control` patch, but edited from the TLS section. */
  tlsEnabled: boolean
}

export interface AuthForm {
  enabled: boolean
  sessionTtlMs: number
  cookieSecure: 'auto' | 'always' | 'never'
  /**
   * Held as a **string** for the form, because `SelectField` is string-valued by design -- the same
   * shape `cookieSecure` uses. `authBaseline`/`formToAuth` convert; the wire form is `boolean | 'loopback'`.
   */
  trustProxy: 'off' | 'loopback' | 'any'
  maxLoginAttempts: number
  lockoutMs: number
}

/** Thresholds for this machine, with the disk paths as the text a person types. */
export interface HostForm {
  enabled: boolean
  intervalMs: number
  diskPaths: string
  diskUsedPercent: number
  memoryUsedPercent: number
  swapUsedPercent: number
  loadPerCpu: number
  tempCelsius: number
}

/** The panel-wide backups policy; `dir` stays a file-level decision. */
/** The page asks for a schedule in hours; the config stores milliseconds. */
const HOUR_MS = 3_600_000

export interface BackupsForm {
  enabled: boolean
  keep: number
  includePaths: string
  scheduleEnabled: boolean
  /** The gap between automatic archives, in hours — the page asks in hours, the file stores ms. */
  scheduleHours: number
  scheduleKeep: number
  /**
   * What an automatic backup captures; `null` is the whole default scope.
   *
   * Held as the wire shape rather than a tree: the tree is a draft inside the scope dialog, and a
   * second copy of it here would be a second thing to keep in step with the saved config.
   */
  scheduleScope: BackupScope | null
}

export interface GlobalSettingsForm {
  control: ListenerForm
  auth: AuthForm
  host: HostForm
  backups: BackupsForm
}

export interface LogsForm {
  persist: boolean
  maxBytes: number
  keep: number
}

export interface DefaultsForm {
  enabled: boolean
  autostart: boolean
  bind: string
  onPortConflict: OnPortConflict
  logBufferLines: number
  restart: RestartConfig
  health: HealthConfig
  stop: StopConfig
}

/** The general block: what a destination inherits unless it opts out. */
export interface PolicyForm {
  onCrash: boolean
  onUnhealthy: boolean
  onForcedRestart: boolean
  onRecovered: boolean
  onHost: boolean
  onDdns: boolean
  cooldownMs: number
}

/**
 * One destination as the form edits it, whichever kind it is.
 *
 * One shape with two optional halves rather than a discriminated union: the list is rendered as
 * rows of the *same* component, and a union would put a `kind` switch in every field binding. The
 * kind decides which half is shown and which is written back.
 */
export interface DestinationForm {
  id: string
  kind: 'telegram' | 'webhook'
  enabled: boolean
  useOwnSettings: boolean
  /** Telegram: the chat, and whether a token is already stored for it. */
  chatId: string
  tokenSet: boolean
  /** Webhook. `headers` is `Name: value` per line — see `providers/webhook.ts`. */
  url: string
  method: 'POST' | 'PUT'
  format: 'json' | 'text'
  headers: string
  /** The destination's own policy; only sent when `useOwnSettings` is true. */
  policy: PolicyForm
}

export interface WorkspaceSettingsForm {
  defaults: DefaultsForm
  logs: LogsForm
  policy: PolicyForm
  destinations: DestinationForm[]
}

/** The schema's own defaults, for a form that has not been filled yet. */
export const SCHEMA_RESTART: RestartConfig = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 1000,
  factor: 2,
  maxDelayMs: 30000,
  resetAfterMs: 60000,
}

export const SCHEMA_HEALTH: HealthConfig = {
  enabled: true,
  mode: 'port',
  http: { scheme: 'http', allowInvalidCert: false, path: '/', method: 'GET', expectStatusBelow: 400, expectBody: '' },
  intervalMs: 5000,
  timeoutMs: 1500,
  unhealthyThreshold: 3,
  forceRestartAfterMs: 0,
  startTimeoutMs: 20000,
}

export const SCHEMA_STOP: StopConfig = {
  signal: 'SIGTERM',
  killGroup: true,
  graceMs: 5000,
  killPortHolders: false,
}

/** A copy of the health group, nested `http` included. */
export function cloneHealth(health: HealthConfig): HealthConfig {
  return { ...health, http: { ...health.http } }
}

/** Schema defaults, used only until the first frame fills each block in. */
export function createGlobalForm(): GlobalSettingsForm {
  return {
    control: { label: 'home-hosted', port: 3999, host: 'local', openBrowser: false, tlsEnabled: false },
    auth: { enabled: false, sessionTtlMs: 604_800_000, cookieSecure: 'auto', trustProxy: 'off', maxLoginAttempts: 5, lockoutMs: 60_000 },
    host: {
      enabled: true,
      intervalMs: 15_000,
      diskPaths: '.',
      diskUsedPercent: 90,
      memoryUsedPercent: 90,
      swapUsedPercent: 50,
      loadPerCpu: 2,
      tempCelsius: 85,
    },
    backups: { enabled: true, keep: 5, includePaths: '', scheduleEnabled: false, scheduleHours: 24, scheduleKeep: 7, scheduleScope: null },
  }
}

/** Schema defaults for the per-workspace blocks. */
export function createWorkspaceForm(): WorkspaceSettingsForm {
  return {
    defaults: {
      enabled: true,
      autostart: false,
      bind: 'local',
      onPortConflict: 'block',
      logBufferLines: 500,
      restart: { ...SCHEMA_RESTART },
      health: cloneHealth(SCHEMA_HEALTH),
      stop: { ...SCHEMA_STOP },
    },
    logs: { persist: true, maxBytes: 2_000_000, keep: 3 },
    // The schema defaults, so an untouched form writes nothing.
    policy: {
      onCrash: true,
      onUnhealthy: true,
      onForcedRestart: true,
      onRecovered: false,
      onHost: true,
      onDdns: true,
      cooldownMs: 120_000,
    },
    // Filled from the live status on load; empty until then.
    destinations: [],
  }
}

/**
 * The wire value of the three-way choice, from either side.
 *
 * One definition, so a diff cannot compare a string against a boolean and report a change nobody made.
 */
export function toWireTrustProxy(value: AuthForm['trustProxy'] | AuthStatus['trustProxy']): boolean | 'loopback' {
  if (value === 'loopback')
    return 'loopback'
  return value === 'any' || value === true
}

/** The wire shape of an `AuthStatus`: what a patch carries, and what a diff compares. */
export function formToAuth(status: AuthStatus): Record<string, unknown> {
  return {
    enabled: status.enabled,
    sessionTtlMs: status.sessionTtlMs,
    cookieSecure: status.cookieSecure,
    trustProxy: toWireTrustProxy(status.trustProxy),
    maxLoginAttempts: status.maxLoginAttempts,
    lockoutMs: status.lockoutMs,
  }
}

export function authBaseline(status: AuthStatus): AuthForm {
  return {
    enabled: status.enabled,
    sessionTtlMs: status.sessionTtlMs,
    cookieSecure: status.cookieSecure as AuthForm['cookieSecure'],
    trustProxy: status.trustProxy === 'loopback' ? 'loopback' : status.trustProxy ? 'any' : 'off',
    maxLoginAttempts: status.maxLoginAttempts,
    lockoutMs: status.lockoutMs,
  }
}

export function listenerBaseline(view: ControlView): ListenerForm {
  return { label: view.label, port: view.port, host: view.host, openBrowser: view.openBrowser, tlsEnabled: view.tls.enabled }
}

export function splitList(value: string): string[] {
  return value.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
}

export function hostBaseline(config: HostConfig): HostForm {
  return {
    enabled: config.enabled,
    intervalMs: config.intervalMs,
    diskPaths: config.diskPaths.join(', '),
    diskUsedPercent: config.diskUsedPercent,
    memoryUsedPercent: config.memoryUsedPercent,
    swapUsedPercent: config.swapUsedPercent,
    loadPerCpu: config.loadPerCpu,
    tempCelsius: config.tempCelsius,
  }
}

/** The schema's own defaults, for a panel that predates the schedule and sends none. */
const SCHEMA_SCHEDULE: BackupScheduleConfig = { intervalMs: 0, keep: 7 }

export function backupsBaseline(policy: Pick<BackupsView, 'enabled' | 'keep' | 'includePaths'> & { schedule?: BackupScheduleConfig }): BackupsForm {
  // Absent means an older panel: it is "off", which is what the schema default says, and the
  // form must not invent a schedule the panel cannot honour.
  const schedule = policy.schedule ?? SCHEMA_SCHEDULE
  return {
    enabled: policy.enabled,
    keep: policy.keep,
    includePaths: policy.includePaths.join(', '),
    scheduleEnabled: schedule.intervalMs > 0,
    // Rounded for display only: the patch leaves `intervalMs` out unless the field was edited,
    // so a 90-minute interval set through the API is not rewritten to 2 hours by an unrelated save.
    scheduleHours: Math.max(1, Math.round(schedule.intervalMs / HOUR_MS) || 1),
    scheduleKeep: schedule.keep,
    // An older panel sends no `scope`, and that means the full default — not "nothing".
    scheduleScope: schedule.scope ?? null,
  }
}

export function hostPatch(current: HostConfig, form: HostForm): Patch {
  return diffFields(current as unknown as Patch, {
    ...form,
    diskPaths: splitList(form.diskPaths),
  } as unknown as Patch)
}

export function backupsPatch(
  current: Pick<BackupsView, 'enabled' | 'keep' | 'includePaths'> & { schedule?: BackupScheduleConfig },
  form: BackupsForm,
): Patch {
  const baseline = backupsBaseline(current)
  const schedule: Record<string, unknown> = {}
  if (form.scheduleEnabled !== baseline.scheduleEnabled || form.scheduleHours !== baseline.scheduleHours)
    schedule.intervalMs = form.scheduleEnabled ? form.scheduleHours * HOUR_MS : 0
  if (form.scheduleKeep !== baseline.scheduleKeep)
    schedule.keep = form.scheduleKeep
  // `null` clears it back to the whole default scope, which is the only spelling for "unchoose";
  // leaving the key out would mean "keep whatever is stored".
  if (!sameScope(form.scheduleScope, baseline.scheduleScope))
    schedule.scope = form.scheduleScope

  return diffFields({
    enabled: current.enabled,
    keep: current.keep,
    includePaths: current.includePaths,
    schedule: current.schedule ?? SCHEMA_SCHEDULE,
  } as unknown as Patch, {
    enabled: form.enabled,
    keep: form.keep,
    includePaths: splitList(form.includePaths),
    schedule,
  } as unknown as Patch, ['schedule'])
}

/** Listener, auth and TLS in one `control` block; only changed keys survive. */
export function controlPatch(view: ControlView, form: GlobalSettingsForm): Patch {
  const current = {
    label: view.label,
    port: view.port,
    host: view.host,
    openBrowser: view.openBrowser,
    // `authBaseline` returns the *form* shape (strings), and `next` below is the *wire* shape, so the
    // comparison is made on the wire shape on both sides.
    auth: formToAuth(view.auth),
    tls: { enabled: view.tls.enabled },
  }
  const next = {
    label: form.control.label,
    port: form.control.port,
    host: form.control.host,
    openBrowser: form.control.openBrowser,
    // `formToAuth` above converts the same way, so both sides of the diff are the *wire* form. Comparing a
    // converted `next` against a string-valued `current` made every save carry a spurious `trustProxy`.
    auth: { ...form.auth, trustProxy: toWireTrustProxy(form.auth.trustProxy) },
    tls: { enabled: form.control.tlsEnabled },
  }
  return diffFields(current, next, ['auth', 'tls'])
}

/** Only the changed sub-keys: the store merges a nested group rather than replacing it. */
export function defaultsPatch(current: ServerDefaults, form: DefaultsForm): Patch {
  return diffFields(current as unknown as Patch, form as unknown as Patch, ['restart', 'health', 'stop'])
}

export function logsPatch(current: LogsConfig, form: LogsForm): Patch {
  return diffFields(current as unknown as Patch, form as unknown as Patch)
}

/** The general block as the form holds it. */
export function policyBaseline(status: Pick<NotificationDefaults, 'onCrash' | 'onUnhealthy' | 'onForcedRestart' | 'onRecovered' | 'onHost' | 'cooldownMs'> & { onDdns?: boolean }): PolicyForm {
  return {
    onCrash: status.onCrash,
    onUnhealthy: status.onUnhealthy,
    onForcedRestart: status.onForcedRestart,
    onRecovered: status.onRecovered,
    onHost: status.onHost,
    // A panel from before DDNS sends no flag; the form treats that as "on".
    onDdns: status.onDdns ?? true,
    cooldownMs: status.cooldownMs,
  }
}

/** One destination as the form holds it, from its status row. */
export function destinationBaseline(status: DestinationStatusView): DestinationForm {
  return {
    id: status.id,
    kind: status.kind,
    enabled: status.enabled,
    useOwnSettings: status.useOwnSettings,
    chatId: status.chatId ?? '',
    tokenSet: status.tokenSet,
    url: status.url ?? '',
    method: status.method ?? 'POST',
    format: status.format ?? 'json',
    headers: status.headers ?? '',
    // The row carries the *effective* policy; on an inheriting destination those are the
    // general block's values, which is what the read-only view should show.
    policy: policyBaseline(status),
  }
}

/** The general block's patch, or null when nothing changed. */
export function policyPatch(current: NotificationDefaults, form: PolicyForm): Patch | null {
  const diff = diffFields({ defaults: policyBaseline(current) }, { defaults: { ...form } }, ['defaults'])
  return Object.keys(diff).length === 0 ? null : diff
}

/** One destination as the API takes it: an inheriting one sends no policy columns. */
function destinationWire(form: DestinationForm): Record<string, unknown> {
  return {
    kind: form.kind,
    id: form.id,
    enabled: form.enabled,
    useOwnSettings: form.useOwnSettings,
    ...(form.kind === 'telegram' ? { chatId: form.chatId } : { url: form.url, method: form.method, format: form.format, headers: form.headers }),
    ...(form.useOwnSettings ? form.policy : {}),
  }
}

/**
 * The whole destination list, because the API **replaces** it — a merge cannot express removing
 * one. That makes the decision to send it a three-way one: `filled` is what this form was filled
 * with, `forms` what it holds, `current` what the panel holds now. Comparing the draft against
 * live* state instead made another client's save look like this form's own edit, and saving an
 * unrelated field then rewrote the list without the entry that had just been added.
 */
export function destinationsPatch(
  current: DestinationStatusView[],
  forms: DestinationForm[],
  filled?: DestinationForm[],
): Patch | null {
  const merged = mergeReplacedList({
    filled,
    draft: forms,
    live: current.map(destinationBaseline),
    key: destination => destination.id,
  })
  return merged === null ? null : { destinations: merged.map(destinationWire) }
}

/**
 * The independently filled blocks of each form.
 *
 * A live frame arrives in pieces: the control view comes from the state stream
 * while the host thresholds and the backups policy come from `/api/settings`,
 * which lands later. Each block is therefore filled on its own, and the one the
 * user is editing is the one that must not be overwritten.
 */
export type GlobalFormBlock = 'control' | 'host' | 'backups'
export type WorkspaceFormBlock = 'defaults' | 'logs' | 'notifications'

/** What a block held when it was last filled; absent means "never filled". */
export type FormSnapshots = Partial<Record<GlobalFormBlock | WorkspaceFormBlock, unknown>>

export function globalBlockSnapshot(form: GlobalSettingsForm, block: GlobalFormBlock): unknown {
  switch (block) {
    case 'control': return { ...form.control, auth: { ...form.auth } }
    case 'host': return { ...form.host }
    case 'backups': return { ...form.backups }
  }
}

/** The three independent groups the `control` block covers on screen. */
export type ControlPart = 'listener' | 'auth' | 'tls'

/** One control group's own snapshot, so each can be tracked and reset separately. */
export function controlPartSnapshot(form: GlobalSettingsForm, part: ControlPart): unknown {
  if (part === 'auth')
    return { ...form.auth }
  if (part === 'tls')
    return form.control.tlsEnabled
  return { label: form.control.label, port: form.control.port, host: form.control.host, openBrowser: form.control.openBrowser }
}

/**
 * Has one control group been edited since its own snapshot?
 *
 * The block snapshot cannot answer this: Listener, Authentication and TLS each have their
 * own Reset button, and a Reset in one re-baselined all three — so renaming the panel and
 * then resetting the session lifetime let the next state frame silently discard the rename.
 */
export function controlPartEdited(form: GlobalSettingsForm, snapshot: unknown, part: ControlPart): boolean {
  if (snapshot === undefined)
    return false
  const parts = snapshot as Partial<Record<ControlPart, unknown>>
  return isBlockEdited(parts[part], controlPartSnapshot(form, part))
}

/** Re-baseline one control group, leaving the other two pending. */
export function rememberControlPart(form: GlobalSettingsForm, snapshots: FormSnapshots, part: ControlPart): void {
  const current = (snapshots.control ?? {}) as Partial<Record<ControlPart, unknown>>
  snapshots.control = { ...current, [part]: controlPartSnapshot(form, part) }
}

/**
 * Every field a block owns, copied.
 *
 * **A block's snapshot must cover every field its form holds**, because `isBlockEdited` decides
 * "somebody is editing, leave it alone" by comparing the two. Omitting one silently un-guards it:
 * the notifications block once snapshotted only `telegram`, so adding a webhook never counted as
 * an edit and every state frame re-filled the list over it — reported as "webhooks settings gets
 * reverted automatically periodically". Keeping the two lists side by side here is what makes the
 * omission visible: add a field to one, add it to the other.
 */
export function workspaceBlockSnapshot(form: WorkspaceSettingsForm, block: WorkspaceFormBlock): unknown {
  switch (block) {
    case 'defaults': return {
      ...form.defaults,
      restart: { ...form.defaults.restart },
      health: cloneHealth(form.defaults.health),
      stop: { ...form.defaults.stop },
    }
    case 'logs': return { ...form.logs }
    /**
     * The whole block: the general policy **and** the destination list.
     *
     * The live-state guard compares this against the form to decide whether somebody is editing,
     * so a field left out of it is a field whose edit no frame protects — the webhook list was
     * once omitted here and every state frame re-filled it while it was being typed.
     */
    case 'notifications': return {
      policy: { ...form.policy },
      destinations: form.destinations.map(destination => ({ ...destination, policy: { ...destination.policy } })),
    }
  }
}

/**
 * The destination list this block was filled with, or `undefined` when it never was.
 *
 * The replaced-list merge needs the baseline, not live state: it is the only record of
 * which entries this form has actually seen, and therefore of which absences are this
 * form's deletions rather than another client's additions.
 */
export function filledDestinations(snapshot: unknown): DestinationForm[] | undefined {
  if (snapshot === undefined || snapshot === null || typeof snapshot !== 'object')
    return undefined
  const destinations = (snapshot as { destinations?: unknown }).destinations
  return Array.isArray(destinations) ? (destinations as DestinationForm[]) : undefined
}

/**
 * True when a block was filled from live state and has been edited since, so the
 * next frame must leave it alone. A block that was never filled is always free:
 * it still holds schema defaults, which differ from the live config in several
 * places (`auth.enabled`, `backups.enabled`) and would otherwise look like a
 * pending edit that blocks its own first fill.
 */
export function isBlockEdited(snapshot: unknown, current: unknown): boolean {
  return snapshot !== undefined && JSON.stringify(snapshot) !== JSON.stringify(current)
}

export function listenerChanged(view: ControlView, form: GlobalSettingsForm): boolean {
  return view.label !== form.control.label
    || view.port !== form.control.port
    || view.host !== form.control.host
    || view.openBrowser !== form.control.openBrowser
}

export function tlsChanged(view: ControlView, form: GlobalSettingsForm): boolean {
  return view.tls.enabled !== form.control.tlsEnabled
}

export function authChanged(view: ControlView, form: GlobalSettingsForm): boolean {
  return countLeaves(diffFields({ ...authBaseline(view.auth) }, { ...form.auth })) > 0
}

/** `NumberField` speaks `number | null`; stored config never carries null. */
export function numberModel(
  get: () => number,
  set: (value: number) => void,
  fallback: number,
): WritableComputedRef<number | null> {
  return computed<number | null>({
    get,
    set: (value) => {
      set(value === null || Number.isNaN(value) ? fallback : value)
    },
  })
}

export interface RebindingOutcome {
  rebinding: boolean
  targetUrl: string | null
  control: { url: string }
}

/**
 * The panel can move its own listener; this page is then talking to a stale
 * origin. Waits for the new one and follows it. Returns a message on failure.
 */
export async function followRebinding(result: RebindingOutcome): Promise<string | null> {
  if (!result.rebinding)
    return null
  const target = result.targetUrl ?? result.control.url
  if (target.length === 0 || target === window.location.origin)
    return null
  if (await waitForEndpoint(target)) {
    window.location.replace(target)
    return null
  }
  return t('settings.rebind.failed', { target })
}
