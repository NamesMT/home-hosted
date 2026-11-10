import type { BackupHookConfig, HealthConfig, HttpCheckConfig, OnPortConflict, RestartConfig, ServerConfig, StopConfig } from './contracts'
import type { Patch } from './patch-diff'
import { clonePlain } from './clone'
import { commaList, envToText, linesToArray, textToEnv } from './fields'
import { repairNumbers } from './form-repair'
import { diffServerConfig } from './patch-diff'
import { isRecord } from './shape'
import { msToSeconds, secondsToMs } from './ui-format'

/**
 * Editing one existing server entry: config → form, form → payload, and the diff that Save sends.
 *
 * `uis/stock`'s `ServerConfigEditor` and `uis/noc-console`'s `ServerConfigView` each carried this
 * whole round trip, and they had drifted: the console read every box with `Number(...)`, so a
 * cleared `grace (ms)` saved `0` — an instant SIGKILL on the next stop — while the stock editor
 * repaired some boxes by hand and clamped others; only one of them could edit `dump`/`load`; both
 * showed the hook timeouts in ms although their floor is a second. The UIs keep their own markup
 * and their own form objects; what a value *means* is decided here, once.
 *
 * Every numeric box is a `NumericInput` — a native `<input>` reports a string, a number field a
 * number, `NaN` or `null` — and a box that decided nothing (blank or unreadable) falls back to the
 * value the form was **filled** from, never to `0`.
 */

/** What a numeric box can hold, across both UIs' controls. */
export type NumericInput = number | string | null | undefined

/** Default hook timeouts, as `contracts.ts` declares them. */
export const BOOTSTRAP_TIMEOUT_MS = 120_000
export const BACKUP_HOOK_TIMEOUT_MS = 600_000

/** Whether a box was left empty, as opposed to holding something unreadable. */
export function isBlankInput(raw: NumericInput): boolean {
  if (typeof raw === 'number')
    return false
  return String(raw ?? '').trim().length === 0
}

/** A numeric box as a number; `NaN` when it decided nothing (blank or unreadable). */
export function readFormNumber(raw: NumericInput): number {
  if (typeof raw === 'number')
    return raw
  const text = String(raw ?? '').trim()
  return text.length === 0 ? Number.NaN : Number(text)
}

/** Every number member of `T` loosened to what a box reports. */
type Loose<T, N> = { [K in keyof T]-?: T[K] extends number ? N : T[K] }

export interface HookForm<N extends NumericInput = NumericInput> {
  enabled: boolean
  command: string
  /** One per line. */
  args: string
  /** `KEY=value` per line. */
  env: string
  /** Seconds: the schema floor is 1000 ms, so a sub-second value is never meaningful. */
  timeoutSeconds: N
}

export interface BootstrapForm<N extends NumericInput = NumericInput> extends HookForm<N> {
  runOnce: boolean
}

/**
 * The form, with `N` the type its numeric boxes hold: a number field's `number | null`, or the
 * string a native `<input>` reports.
 */
export interface ServerEditForm<N extends NumericInput = NumericInput> {
  label: string
  command: string
  cwd: string
  /** One per line. */
  args: string
  env: string
  dataEnvs: string
  backupPaths: string
  backupIgnoreGenerated: boolean
  /** Comma separated. */
  dependsOn: string
  envFile: string
  /** MiB; blank is "no guard". */
  maxRssMb: N
  /** Blank is "no port". */
  port: N
  bind: string
  onPortConflict: OnPortConflict
  logBufferLines: N
  enabled: boolean
  autostart: boolean
  persistent: boolean
  restart: Loose<RestartConfig, N>
  health: Omit<Loose<HealthConfig, N>, 'http'> & { http: Omit<Loose<HttpCheckConfig, N>, 'expectStatus'> & { expectStatus: N } }
  stop: Loose<StopConfig, N>
  bootstrap: BootstrapForm<N>
  dump: HookForm<N>
  load: HookForm<N>
}

function hookForm(hook: { command: string, args: string[], env: Record<string, string>, timeoutMs: number } | null | undefined, defaultMs: number): HookForm<number | null> {
  return {
    enabled: hook !== null && hook !== undefined,
    command: hook?.command ?? '',
    args: (hook?.args ?? []).join('\n'),
    env: envToText(hook?.env ?? {}),
    timeoutSeconds: msToSeconds(hook?.timeoutMs ?? defaultMs),
  }
}

/** A config as the form a person edits. Detached: nothing in it aliases `config`. */
export function serverEditForm(config: ServerConfig): ServerEditForm<number | null> {
  return {
    label: config.label ?? '',
    command: config.command,
    cwd: config.cwd,
    args: config.args.join('\n'),
    env: envToText(config.env),
    dataEnvs: envToText(config.dataEnvs),
    backupPaths: config.backupPaths.join('\n'),
    // Absent in a payload from a panel that predates the field: the default is on.
    backupIgnoreGenerated: config.backupIgnoreGenerated !== false,
    dependsOn: config.dependsOn.join(', '),
    envFile: config.envFile,
    maxRssMb: config.resources.maxRssBytes > 0 ? Math.round(config.resources.maxRssBytes / 1024 / 1024) : null,
    port: config.port ?? null,
    bind: config.bind,
    onPortConflict: config.onPortConflict,
    logBufferLines: config.logBufferLines,
    enabled: config.enabled,
    autostart: config.autostart,
    // Absent in a payload from a panel that predates the field: the default is off.
    persistent: config.persistent === true,
    restart: { ...config.restart },
    health: { ...config.health, http: { ...config.health.http, expectStatus: config.health.http.expectStatus ?? null } },
    stop: { ...config.stop },
    bootstrap: { ...hookForm(config.bootstrap, BOOTSTRAP_TIMEOUT_MS), runOnce: config.bootstrap?.runOnce ?? true },
    dump: hookForm(config.dump, BACKUP_HOOK_TIMEOUT_MS),
    load: hookForm(config.load, BACKUP_HOOK_TIMEOUT_MS),
  }
}

/**
 * Seconds back to the stored ms, keeping the filled value when the box still shows it.
 *
 * A stored `1500` reads `2` s; writing `2000` back for a box nobody touched would be a phantom
 * change on every open, so an unchanged reading keeps the exact stored milliseconds.
 */
export function hookTimeoutMs(raw: NumericInput, filledMs: number | undefined, defaultMs: number): number {
  const seconds = readFormNumber(raw)
  const fallback = filledMs ?? defaultMs
  if (!Number.isFinite(seconds) || seconds === msToSeconds(fallback))
    return fallback
  return secondsToMs(seconds)
}

function hookPayload(form: HookForm, filled: BackupHookConfig | null | undefined): Patch | null {
  if (!form.enabled)
    return null
  return {
    command: form.command.trim(),
    args: linesToArray(form.args),
    env: textToEnv(form.env),
    timeoutMs: hookTimeoutMs(form.timeoutSeconds, filled?.timeoutMs, BACKUP_HOOK_TIMEOUT_MS),
    // Not edited here, but the group is replaced whole: leaving it out would reset it to 2 s.
    ...(filled?.waitMs === undefined ? {} : { waitMs: filled.waitMs }),
  }
}

/** Every number-shaped member read as a number, nested groups included. */
function readNumbers(group: Record<string, unknown>, template: Record<string, unknown>): Record<string, unknown> {
  const read: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(group)) {
    const shape = template[key]
    if (isRecord(value) && isRecord(shape))
      read[key] = readNumbers(value, shape)
    else if (typeof shape === 'number')
      read[key] = readFormNumber(value as NumericInput)
    else
      read[key] = value
  }
  return read
}

/** A lifecycle group with every cleared box put back to the value the form was filled with. */
function lifecycle<T>(group: object, filled: T): T {
  const read = readNumbers(group as Record<string, unknown>, filled as Record<string, unknown>)
  return repairNumbers(read, filled as Record<string, unknown>) as T
}

/**
 * The whole entry as the form now describes it.
 *
 * `filled` is the config the form was filled from: a box that decided nothing falls back to its
 * value. That is also what `serverEditPatch` diffs against, so an untouched field never travels.
 */
export function serverEditPayload(form: ServerEditForm, filled: ServerConfig): Patch {
  const maxRssMb = readFormNumber(form.maxRssMb)
  const logBufferLines = readFormNumber(form.logBufferLines)
  const expectStatus = form.health.http.expectStatus
  const health = lifecycle<HealthConfig>({ ...form.health, http: { ...form.health.http, expectStatus: undefined } }, filled.health)
  return {
    // An emptied label sends **null**, which removes the key so every display falls back to the id;
    // `''` would be stored, and `label ?? id` does not fire on an empty string.
    label: form.label.trim().length === 0 ? null : form.label.trim(),
    command: form.command.trim(),
    cwd: form.cwd.trim() === '' ? '.' : form.cwd.trim(),
    args: linesToArray(form.args),
    env: textToEnv(form.env),
    dataEnvs: textToEnv(form.dataEnvs),
    backupPaths: linesToArray(form.backupPaths),
    backupIgnoreGenerated: form.backupIgnoreGenerated,
    dependsOn: commaList(form.dependsOn),
    envFile: form.envFile.trim(),
    resources: { maxRssBytes: Number.isFinite(maxRssMb) && maxRssMb > 0 ? Math.round(maxRssMb * 1024 * 1024) : 0 },
    // Blank is "no port"; something unreadable stays NaN so validation names it.
    port: isBlankInput(form.port) ? null : readFormNumber(form.port),
    bind: form.bind.trim(),
    onPortConflict: form.onPortConflict,
    logBufferLines: Number.isFinite(logBufferLines) ? logBufferLines : filled.logBufferLines,
    enabled: form.enabled,
    autostart: form.autostart,
    persistent: form.persistent,
    restart: lifecycle(form.restart, filled.restart),
    health: {
      ...health,
      // `null` clears the exact-status check; a blank box means "any below".
      http: { ...health.http, expectStatus: isBlankInput(expectStatus) ? null : readFormNumber(expectStatus) },
    },
    stop: lifecycle(form.stop, filled.stop),
    bootstrap: form.bootstrap.enabled
      ? {
          command: form.bootstrap.command.trim(),
          args: linesToArray(form.bootstrap.args),
          env: textToEnv(form.bootstrap.env),
          timeoutMs: hookTimeoutMs(form.bootstrap.timeoutSeconds, filled.bootstrap?.timeoutMs, BOOTSTRAP_TIMEOUT_MS),
          runOnce: form.bootstrap.runOnce,
        }
      : null,
    dump: hookPayload(form.dump, filled.dump),
    load: hookPayload(form.load, filled.load),
  }
}

/**
 * Exactly what Save writes: the payload minus everything equal to the **filled** snapshot.
 *
 * Diffing against live state instead would treat another client's change as this form's own and
 * write the old value back over it.
 */
export function serverEditPatch(form: ServerEditForm, filled: ServerConfig): Patch {
  return diffServerConfig(filled, serverEditPayload(form, filled))
}

/**
 * Whether a live config object is a genuine change from the one a form was filled from.
 *
 * By value, because the control plane re-creates every config object on each state frame: an
 * identity check would call every frame a change. `snapshot` must be an independent copy.
 */
export function isLiveConfigChange(next: unknown, snapshot: unknown): boolean {
  if (next === null || next === undefined)
    return false
  return JSON.stringify(next) !== JSON.stringify(snapshot ?? null)
}

/**
 * What an open editor does when a state frame arrives.
 *
 * `keep` — nothing changed. `refill` — the config moved and the form holds no edits, so it shows the
 * new values. `notice` — it moved while the form holds edits: they are kept (Save sends only them),
 * and the person is told, rather than having what they typed wiped by someone else's save.
 */
export function liveConfigUpdate(next: ServerConfig | null | undefined, filled: ServerConfig, dirty: boolean): 'keep' | 'refill' | 'notice' {
  if (!isLiveConfigChange(next, filled))
    return 'keep'
  return dirty ? 'notice' : 'refill'
}

/** A detached snapshot of the config a form is filled from. */
export function fillSnapshot(config: ServerConfig): ServerConfig {
  return clonePlain(config)
}
