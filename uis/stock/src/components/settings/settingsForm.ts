import type {
  AuthStatus,
  BackupsConfig,
  ControlView,
  HealthConfig,
  HostConfig,
  LogsConfig,
  OnPortConflict,
  RestartConfig,
  ServerDefaults,
  StopConfig,
  TelegramStatus,
} from '@shared/contracts'
import type { Patch } from '@shared/patch-diff'
import type { WritableComputedRef } from 'vue'
import { countLeaves, diffFields } from '@shared/patch-diff'
import { computed } from 'vue'
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
   * shape `cookieSecure` uses. `authBaseline` converts; the wire form is `boolean | 'loopback'`.
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
export interface BackupsForm {
  enabled: boolean
  keep: number
  includePaths: string
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

export interface TelegramForm {
  enabled: boolean
  chatId: string
  cooldownMs: number
  onCrash: boolean
  onUnhealthy: boolean
  onForcedRestart: boolean
  onRecovered: boolean
  onHost: boolean
  onDdns: boolean
}

export interface WorkspaceSettingsForm {
  defaults: DefaultsForm
  logs: LogsForm
  telegram: TelegramForm
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
  http: { path: '/', method: 'GET', expectStatusBelow: 400, expectBody: '' },
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
    backups: { enabled: true, keep: 5, includePaths: '' },
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
    telegram: {
      enabled: false,
      chatId: '',
      cooldownMs: 120_000,
      onCrash: true,
      onUnhealthy: true,
      onForcedRestart: true,
      onRecovered: false,
      onHost: true,
      onDdns: true,
    },
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

/** A panel from before DDNS sends no flag; the form treats that as "on". */
export function telegramBaseline(status: TelegramStatus): TelegramForm {
  return {
    enabled: status.enabled,
    chatId: status.chatId,
    cooldownMs: status.cooldownMs,
    onCrash: status.onCrash,
    onUnhealthy: status.onUnhealthy,
    onForcedRestart: status.onForcedRestart,
    onRecovered: status.onRecovered,
    onHost: status.onHost,
    onDdns: status.onDdns ?? true,
  }
}

/** A comma-separated field back into the list the config stores. */
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

export function backupsBaseline(policy: Pick<BackupsConfig, 'enabled' | 'keep' | 'includePaths'>): BackupsForm {
  return { enabled: policy.enabled, keep: policy.keep, includePaths: policy.includePaths.join(', ') }
}

export function hostPatch(current: HostConfig, form: HostForm): Patch {
  return diffFields(current as unknown as Patch, {
    ...form,
    diskPaths: splitList(form.diskPaths),
  } as unknown as Patch)
}

export function backupsPatch(current: Pick<BackupsConfig, 'enabled' | 'keep' | 'includePaths'>, form: BackupsForm): Patch {
  return diffFields(current as unknown as Patch, {
    ...form,
    includePaths: splitList(form.includePaths),
  } as unknown as Patch)
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
    // Converted the same way `authBaseline` does, so both sides of the diff are the *wire* form. Comparing
    // a converted `next` against a string-valued `current` made every save carry a spurious `trustProxy`.
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

/** Telegram policy only — the bot token is a secret with its own endpoint. */
export function telegramPatch(current: TelegramStatus, form: TelegramForm): Patch {
  return diffFields({ telegram: telegramBaseline(current) }, { telegram: { ...form } }, ['telegram'])
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
export type WorkspaceFormBlock = 'defaults' | 'logs' | 'telegram'

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

export function workspaceBlockSnapshot(form: WorkspaceSettingsForm, block: WorkspaceFormBlock): unknown {
  switch (block) {
    case 'defaults': return {
      ...form.defaults,
      restart: { ...form.defaults.restart },
      health: cloneHealth(form.defaults.health),
      stop: { ...form.defaults.stop },
    }
    case 'logs': return { ...form.logs }
    case 'telegram': return { ...form.telegram }
  }
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
  return `The control panel did not answer on ${target}. Check the console for the new listener.`
}
