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
 * Editable form shapes for the settings blocks the panel actually writes.
 * Everything a server can be trusted with is derived from `AppState`, so the
 * form is a plain, independent copy: a live SSE frame must never edit it.
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
  trustProxy: boolean
  maxLoginAttempts: number
  lockoutMs: number
}

export interface LogsForm {
  persist: boolean
  maxBytes: number
  keep: number
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

/** The backups policy the panel owns; `dir` stays a file-level decision. */
export interface BackupsForm {
  enabled: boolean
  keep: number
  includePaths: string
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

export interface SettingsForm {
  control: ListenerForm
  auth: AuthForm
  defaults: DefaultsForm
  logs: LogsForm
  host: HostForm
  backups: BackupsForm
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

/** Schema defaults, used only until the first SSE frame fills the form in. */
export function createSettingsForm(): SettingsForm {
  return {
    control: { label: 'home-hosted', port: 3999, host: 'local', openBrowser: false, tlsEnabled: false },
    auth: { enabled: false, sessionTtlMs: 604_800_000, cookieSecure: 'auto', trustProxy: false, maxLoginAttempts: 5, lockoutMs: 60_000 },
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
    telegram: {
      enabled: false,
      chatId: '',
      cooldownMs: 120_000,
      onCrash: true,
      onUnhealthy: true,
      onForcedRestart: true,
      onRecovered: false,
      onHost: true,
    },
  }
}

export function authBaseline(status: AuthStatus): AuthForm {
  return {
    enabled: status.enabled,
    sessionTtlMs: status.sessionTtlMs,
    cookieSecure: status.cookieSecure as AuthForm['cookieSecure'],
    trustProxy: status.trustProxy,
    maxLoginAttempts: status.maxLoginAttempts,
    lockoutMs: status.lockoutMs,
  }
}

export function listenerBaseline(view: ControlView): ListenerForm {
  return { label: view.label, port: view.port, host: view.host, openBrowser: view.openBrowser, tlsEnabled: view.tls.enabled }
}

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
export function controlPatch(view: ControlView, form: SettingsForm): Patch {
  const current = {
    label: view.label,
    port: view.port,
    host: view.host,
    openBrowser: view.openBrowser,
    auth: authBaseline(view.auth),
    tls: { enabled: view.tls.enabled },
  }
  const next = {
    label: form.control.label,
    port: form.control.port,
    host: form.control.host,
    openBrowser: form.control.openBrowser,
    auth: { ...form.auth },
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
  const patch = diffFields({ telegram: telegramBaseline(current) }, { telegram: { ...form } }, ['telegram'])
  return patch
}

/**
 * The independently filled groups of the form.
 *
 * A live frame arrives in pieces: the control view comes from the state stream
 * while the host thresholds and the backups policy come from `/api/settings`,
 * which lands later. Each group is therefore filled on its own, and the one the
 * user is editing is the one that must not be overwritten.
 */
export type FormBlock = 'control' | 'defaults' | 'logs' | 'telegram' | 'host' | 'backups'

/** What each block held when it was last filled; absent means "never filled". */
export type FormSnapshots = Partial<Record<FormBlock, unknown>>

/** The block's current value, stable enough to compare with `JSON.stringify`. */
export function blockSnapshot(form: SettingsForm, block: FormBlock): unknown {
  switch (block) {
    case 'control': return {
      ...form.control,
      auth: { ...form.auth },
    }
    case 'defaults': return {
      ...form.defaults,
      restart: { ...form.defaults.restart },
      health: cloneHealth(form.defaults.health),
      stop: { ...form.defaults.stop },
    }
    case 'logs': return { ...form.logs }
    case 'telegram': return { ...form.telegram }
    case 'host': return { ...form.host }
    case 'backups': return { ...form.backups }
  }
}

/**
 * True when a block was filled from live state and has been edited since, so the
 * next frame must leave it alone. A block that was never filled is always free:
 * it still holds schema defaults, which differ from the live config in several
 * places (`auth.enabled`, `backups.enabled`) and would otherwise look like a
 * pending edit that blocks its own first fill.
 */
export function isBlockEdited(form: SettingsForm, snapshots: FormSnapshots, block: FormBlock): boolean {
  const snapshot = snapshots[block]
  return snapshot !== undefined && JSON.stringify(snapshot) !== JSON.stringify(blockSnapshot(form, block))
}

export function listenerChanged(view: ControlView, form: SettingsForm): boolean {
  return view.label !== form.control.label
    || view.port !== form.control.port
    || view.host !== form.control.host
    || view.openBrowser !== form.control.openBrowser
}

export function tlsChanged(view: ControlView, form: SettingsForm): boolean {
  return view.tls.enabled !== form.control.tlsEnabled
}

export function authChanged(view: ControlView, form: SettingsForm): boolean {
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
