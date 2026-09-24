import type {
  AuthStatus,
  BackupsConfig,
  ControlView,
  HealthConfig,
  HostConfig,
  LogsConfig,
  RestartConfig,
  ServerDefaults,
  StopConfig,
  TelegramStatus,
} from '@shared/contracts'
import type { Patch } from '@shared/patch-diff'
import type { WritableComputedRef } from 'vue'
import { diffFields } from '@shared/patch-diff'
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
  onPortConflict: 'block' | 'warn' | 'follow' | 'reclaim'
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

const DEFAULT_RESTART: RestartConfig = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 1000,
  factor: 2,
  maxDelayMs: 30000,
  resetAfterMs: 60000,
}

const DEFAULT_HEALTH: HealthConfig = {
  enabled: true,
  mode: 'port',
  http: { path: '/', method: 'GET', expectStatusBelow: 400, expectBody: '' },
  intervalMs: 5000,
  timeoutMs: 1500,
  unhealthyThreshold: 3,
  forceRestartAfterMs: 0,
  startTimeoutMs: 20000,
}

const DEFAULT_STOP: StopConfig = {
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
      restart: { ...DEFAULT_RESTART },
      health: cloneHealth(DEFAULT_HEALTH),
      stop: { ...DEFAULT_STOP },
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

/**
 * `diffFields` compares nested group members by reference, and `health.http` is
 * the only object down there: drop it again when its contents did not change.
 */
export function defaultsPatch(current: ServerDefaults, form: DefaultsForm): Patch {
  const patch = diffFields(current as unknown as Patch, form as unknown as Patch, ['restart', 'health', 'stop'])
  const health = patch.health as Patch | undefined
  if (health !== undefined && 'http' in health && JSON.stringify(current.health.http) === JSON.stringify(form.health.http)) {
    delete health.http
    if (Object.keys(health).length === 0)
      delete patch.health
  }
  return patch
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
 * When the form may be overwritten from live state.
 *
 * The form starts as *schema defaults*, and some differ from the live config —
 * `auth.enabled` is `true` in the config and `false` in the form. A bare
 * "nothing has changed" guard therefore never passes on a fresh page: the diff
 * against the defaults already looks like a pending edit, so the page showed the
 * wrong value *and* offered to revert it. Only a filled form may refuse.
 */
export function shouldHydrate(state: { hydrated: boolean, liveAvailable: boolean, changedCount: number }): boolean {
  if (!state.liveAvailable)
    return false
  return !state.hydrated || state.changedCount === 0
}

export interface FieldChange {
  path: string
  from: unknown
  to: unknown
}

/** Flattens `{ a: { b: 1 } }` into `[{ path: 'a.b', value: 1 }]`. */
export function flattenLeaves(value: unknown, prefix = ''): Array<{ path: string, value: unknown }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return [{ path: prefix, value }]
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, inner]) => flattenLeaves(inner, prefix.length === 0 ? key : `${prefix}.${key}`))
}

/**
 * The pending patch as a readable list: what each changed leaf was, and what it
 * is about to become. Values a snapshot does not have show as "unset".
 */
export function describeChanges(patch: Patch, current: Patch): FieldChange[] {
  const before = new Map(flattenLeaves(current).map(entry => [entry.path, entry.value]))
  return flattenLeaves(patch).map(entry => ({
    path: entry.path,
    from: before.get(entry.path),
    to: entry.value,
  }))
}

/** Leaf count of a patch, for the "N fields changed" summary. */
export function countLeaves(patch: Patch): number {
  let total = 0
  for (const value of Object.values(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value))
      total += countLeaves(value as Patch)
    else total += 1
  }
  return total
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
