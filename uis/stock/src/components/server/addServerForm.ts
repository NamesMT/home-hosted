import type { HealthConfig, RestartConfig, ServerCreate, ServerDefaults, StopConfig } from '@shared/contracts'
import { diffFields } from '@shared/patch-diff'
import { cloneHealth, SCHEMA_HEALTH, SCHEMA_RESTART, SCHEMA_STOP } from '@/components/settings/settingsForm'
import { commaList, linesToArray, textToEnv } from '@/lib/fields'

/**
 * The add-server dialog's form, as data.
 *
 * It lives outside the component so the dialog → payload mapping is testable on
 * its own: every option the advanced fold offers has to reach
 * `servers.config.json`, and forgetting one there is silent.
 *
 * Restart, health, stop and bootstrap start out *equal to the panel defaults*
 * and only travel when the person changed them, so an entry that leaves them
 * alone keeps inheriting the defaults instead of freezing today's values.
 */

export interface AddServerForm {
  id: string
  label: string
  command: string
  args: string
  cwd: string
  port: number | null
  bind: string
  autostart: boolean
  enabled: boolean
  onPortConflict: ServerCreate['onPortConflict']
  logBufferLines: number | null
  dependsOn: string
  envFile: string
  env: string
  dataEnvs: string
  backupPaths: string
  backupIgnoreGenerated: boolean
  maxRssMb: number | null
  restart: RestartConfig
  health: HealthConfig
  stop: StopConfig
  bootstrapEnabled: boolean
  bootstrapCommand: string
  bootstrapArgs: string
  bootstrapEnv: string
  bootstrapTimeoutMs: number | null
  bootstrapRunOnce: boolean
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

export function blankAddServerForm(defaults?: ServerDefaults): AddServerForm {
  return {
    id: '',
    label: '',
    command: '',
    args: '',
    cwd: '',
    port: null,
    bind: defaults?.bind ?? 'local',
    autostart: defaults?.autostart ?? false,
    enabled: defaults?.enabled ?? true,
    onPortConflict: defaults?.onPortConflict ?? 'block',
    logBufferLines: null,
    dependsOn: '',
    envFile: '',
    env: '',
    dataEnvs: '',
    backupPaths: '',
    backupIgnoreGenerated: true,
    maxRssMb: null,
    restart: { ...(defaults?.restart ?? SCHEMA_RESTART) },
    health: cloneHealth(defaults?.health ?? SCHEMA_HEALTH),
    stop: { ...(defaults?.stop ?? SCHEMA_STOP) },
    bootstrapEnabled: false,
    bootstrapCommand: '',
    bootstrapArgs: '',
    bootstrapEnv: '',
    bootstrapTimeoutMs: 120_000,
    bootstrapRunOnce: true,
  }
}

/** A blank, non-nullable numeric field is `NaN` while it is being cleared. */
function finite(value: number | null): number {
  return value !== null && Number.isFinite(value) ? value : 0
}

/**
 * What an entry would inherit if the body said nothing about it: the schema's own
 * defaults, with the panel's `Settings → Server defaults` on top.
 */
function inheritBaseline(defaults?: ServerDefaults): Record<string, unknown> {
  return {
    args: [],
    cwd: '.',
    env: {},
    dataEnvs: {},
    dependsOn: [],
    envFile: '',
    backupPaths: [],
    backupIgnoreGenerated: true,
    resources: { maxRssBytes: 0 },
    bind: defaults?.bind ?? 'local',
    enabled: defaults?.enabled ?? true,
    autostart: defaults?.autostart ?? false,
    onPortConflict: defaults?.onPortConflict ?? 'block',
    logBufferLines: defaults?.logBufferLines ?? 500,
  }
}

export function addServerPortError(port: number | null): string | null {
  if (port === null || Number.isNaN(port))
    return null
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? null
    : 'Port must be a whole number between 1 and 65535.'
}

/**
 * The request body: what the person decided, and nothing else.
 *
 * A value equal to what the entry would inherit is left out, so it stays
 * inherited — changing `Settings → Server defaults` later still reaches this
 * entry. That is the rule the editor already applies to an edit, and it keeps a
 * new entry down to the fields someone actually touched.
 */
export function addServerPayload(form: AddServerForm, defaults?: ServerDefaults): ServerCreate {
  const rssMb = finite(form.maxRssMb)
  const bootstrapMs = finite(form.bootstrapTimeoutMs)
  const baseline = inheritBaseline(defaults)

  // A policy group is compared as a whole, against the same baseline: untouched,
  // it is left out and the entry keeps inheriting the panel's restart/health/stop.
  const groups = diffFields(
    {
      restart: defaults?.restart ?? SCHEMA_RESTART,
      health: defaults?.health ?? SCHEMA_HEALTH,
      stop: defaults?.stop ?? SCHEMA_STOP,
    },
    { restart: form.restart, health: form.health, stop: form.stop },
  )

  const flat = diffFields(baseline, {
    args: linesToArray(form.args),
    cwd: form.cwd.trim().length > 0 ? form.cwd.trim() : '.',
    env: textToEnv(form.env),
    dataEnvs: textToEnv(form.dataEnvs),
    dependsOn: commaList(form.dependsOn),
    envFile: form.envFile.trim(),
    backupPaths: linesToArray(form.backupPaths),
    backupIgnoreGenerated: form.backupIgnoreGenerated,
    resources: { maxRssBytes: rssMb > 0 ? Math.round(rssMb * 1024 * 1024) : 0 },
    // The select offers `local` and `lan` only; `SelectField` speaks plain strings.
    bind: form.bind,
    enabled: form.enabled,
    autostart: form.autostart,
    onPortConflict: form.onPortConflict,
    // Blank means "inherit", and a value equal to the default is left out too.
    logBufferLines: finite(form.logBufferLines) > 0 ? finite(form.logBufferLines) : baseline.logBufferLines,
  })

  return {
    ...flat,
    ...groups,
    id: form.id.trim(),
    ...(form.label.trim().length === 0 ? {} : { label: form.label.trim() }),
    command: form.command.trim(),
    ...(form.port === null || Number.isNaN(form.port) ? {} : { port: form.port }),
    ...(form.bootstrapEnabled
      ? {
          bootstrap: {
            command: form.bootstrapCommand.trim(),
            args: linesToArray(form.bootstrapArgs),
            env: textToEnv(form.bootstrapEnv),
            timeoutMs: bootstrapMs >= 1000 ? bootstrapMs : 120_000,
            runOnce: form.bootstrapRunOnce,
          },
        }
      : {}),
  }
}

/** The first thing that stops this form from being created, or null. */
export function addServerProblem(form: AddServerForm): string | null {
  if (form.id.trim().length === 0)
    return 'An id is required — it is the key this server lives under.'
  if (!ID_PATTERN.test(form.id.trim()))
    return 'The id must start with a lowercase letter or digit and contain only lowercase letters, digits, dashes and underscores.'
  if (form.command.trim().length === 0)
    return 'A command is required — the executable the supervisor spawns.'
  if (form.bootstrapEnabled && form.bootstrapCommand.trim().length === 0)
    return 'A bootstrap needs a command to run.'
  return addServerPortError(form.port)
}
