import type { ServerCreate } from '@shared/contracts'
import { commaList, linesToArray, textToEnv } from '@/lib/fields'

/**
 * The add-server dialog's form, as data.
 *
 * It lives outside the component so the dialog → payload mapping is testable on
 * its own: every option the advanced fold offers has to reach
 * `servers.config.json`, and forgetting one there is silent.
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
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

export function blankAddServerForm(): AddServerForm {
  return {
    id: '',
    label: '',
    command: '',
    args: '',
    cwd: '',
    port: null,
    bind: 'local',
    autostart: false,
    enabled: true,
    onPortConflict: 'block',
    logBufferLines: null,
    dependsOn: '',
    envFile: '',
    env: '',
    dataEnvs: '',
    backupPaths: '',
    backupIgnoreGenerated: true,
    maxRssMb: null,
  }
}

/** A blank, non-nullable numeric field is `NaN` while it is being cleared. */
function finite(value: number | null): number {
  return value !== null && Number.isFinite(value) ? value : 0
}

export function addServerPortError(port: number | null): string | null {
  if (port === null || Number.isNaN(port))
    return null
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? null
    : 'Port must be a whole number between 1 and 65535.'
}

/** The request body: only fields a person actually filled in are sent. */
export function addServerPayload(form: AddServerForm): ServerCreate {
  const rssMb = finite(form.maxRssMb)
  return {
    id: form.id.trim(),
    ...(form.label.trim().length === 0 ? {} : { label: form.label.trim() }),
    command: form.command.trim(),
    args: linesToArray(form.args),
    cwd: form.cwd.trim().length > 0 ? form.cwd.trim() : '.',
    ...(form.port === null || Number.isNaN(form.port) ? {} : { port: form.port }),
    // The select offers `local` and `lan` only; `SelectField` speaks plain strings.
    bind: form.bind as ServerCreate['bind'],
    autostart: form.autostart,
    enabled: form.enabled,
    onPortConflict: form.onPortConflict,
    // A blank field inherits the default instead of sending an out-of-bounds 0.
    ...(finite(form.logBufferLines) > 0 ? { logBufferLines: finite(form.logBufferLines) } : {}),
    dependsOn: commaList(form.dependsOn),
    envFile: form.envFile.trim(),
    env: textToEnv(form.env),
    dataEnvs: textToEnv(form.dataEnvs),
    backupPaths: linesToArray(form.backupPaths),
    backupIgnoreGenerated: form.backupIgnoreGenerated,
    resources: { maxRssBytes: rssMb > 0 ? Math.round(rssMb * 1024 * 1024) : 0 },
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
  return addServerPortError(form.port)
}
