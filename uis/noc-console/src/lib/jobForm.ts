import type { JobRow } from '@shared/api-client'

/**
 * The console's job form, as data.
 *
 * Same shape as `@/lib/serverForm`: the fields a job has, what each is called, and which of them a
 * block holds. It exists because the console already renders its server form this way, and a job form
 * typed straight into the view would be the second spelling of a field catalogue — the drift the
 * `FORM_LAYOUT` extraction was made to stop.
 *
 * A job's `id` is deliberately **absent**: it names the run's log file, its run history and its stored
 * secret values, so it cannot be edited. The sheet shows it as a read-only line with that reason.
 */

/** Every field either mode draws, under the name the form object carries. */
export type JobFieldKey
  = | 'label' | 'command' | 'args' | 'schedule' | 'cwd' | 'timeoutSeconds' | 'enabled' | 'secretEnv'

/** What the form holds. Numeric fields are text, so a cleared box stays distinguishable from 0. */
export interface JobForm {
  label: string
  command: string
  args: string
  schedule: string
  cwd: string
  timeoutSeconds: string
  enabled: boolean
  secretEnv: string
}

export interface JobFieldSpec {
  label: string
  control: 'text' | 'textarea' | 'check'
  hint?: string
  placeholder?: string
  rows?: number
  required?: boolean
  /** `inputmode="numeric"` on a box that is still a string. */
  numeric?: boolean
  /** `grid__full`: the field spans every column. */
  full?: boolean
}

export interface JobFormSection {
  container: 'grid' | 'group'
  title?: string
  fields: JobFieldKey[]
  /** Entry-point markup drawn **directly after** one of this block's fields, inside its grid. */
  slots?: Array<{ after: JobFieldKey, name: string }>
}

/**
 * The fields, spelled once.
 *
 * `command` and `schedule` are the only required ones — the schema refuses a job with either missing,
 * and a job with no schedule would never run.
 */
export const JOB_FIELDS: Record<JobFieldKey, JobFieldSpec> = {
  label: { label: 'label', control: 'text', placeholder: 'falls back to the id' },
  command: { label: 'command', control: 'text', placeholder: './scripts/backup.sh', required: true, full: true },
  args: {
    label: 'args — one per line',
    control: 'textarea',
    rows: 3,
    placeholder: '--full\n--keep=14',
    hint: 'one argument per line, no shell parsing; {id} {label} {cwd} {projectDir} expand',
    full: true,
  },
  schedule: {
    label: 'schedule',
    control: 'text',
    placeholder: '0 3 * * *',
    required: true,
    hint: '5-field cron in the host’s local time: minute hour day month weekday',
  },
  cwd: { label: 'cwd', control: 'text', placeholder: '.', hint: 'relative to the project the panel was started from' },
  timeoutSeconds: { label: 'timeout (s)', control: 'text', numeric: true, hint: 'how long one run may take before the panel stops it' },
  enabled: { label: 'enabled', control: 'check', hint: 'off keeps the job but stops it running on its schedule' },
  secretEnv: {
    label: 'secret env names',
    control: 'textarea',
    rows: 2,
    placeholder: 'BACKUP_TOKEN',
    hint: 'one name per line — set each value in the boxes right below; values live in the workspace secrets file, never in this config',
    full: true,
  },
}

/**
 * How the sheet lays its fields out.
 *
 * The secret **names** and their value boxes are one group, and the value block is anchored after the
 * names field rather than appended to the end of the form: a section-level slot can only render after
 * the whole block, which is how the same panel ended up 1897 px from the names that declare it in the
 * server form. The anchor is data here for exactly that reason.
 */
export const JOB_FORM_LAYOUT: JobFormSection[] = [
  { container: 'grid', fields: ['label', 'command', 'args', 'schedule', 'cwd', 'timeoutSeconds', 'enabled'] },
  {
    container: 'group',
    title: 'secret environment',
    fields: ['secretEnv'],
    slots: [{ after: 'secretEnv', name: 'secret-values' }],
  },
]

/** The schema's own default for `timeoutMs`, in the seconds the box shows. */
export const JOB_DEFAULT_TIMEOUT_SECONDS = 3600

/** A blank form, for creating one. */
export function blankJobForm(): JobForm {
  return {
    label: '',
    command: '',
    args: '',
    schedule: '',
    cwd: '',
    timeoutSeconds: String(JOB_DEFAULT_TIMEOUT_SECONDS),
    enabled: true,
    secretEnv: '',
  }
}

/**
 * The form for an **existing** job, filled from the stored entry.
 *
 * Never from the blank form: a sheet that opened on the defaults would reset the `cwd`, the timeout
 * and `enabled` on the first save, and the person would only find out when the job next ran.
 */
export function jobFormFrom(job: JobRow): JobForm {
  return {
    label: job.label ?? '',
    command: job.command,
    args: job.args.join('\n'),
    schedule: job.schedule,
    cwd: job.cwd ?? '',
    timeoutSeconds: String(Math.round((job.timeoutMs ?? JOB_DEFAULT_TIMEOUT_SECONDS * 1000) / 1000)),
    enabled: job.enabled,
    secretEnv: (job.secretEnv ?? []).join('\n'),
  }
}

/** One entry per line, blank lines dropped and each trimmed. */
export function jobLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
}

/** The declared secret names, deduplicated in the order they were typed. */
export function jobSecretNames(text: string): string[] {
  return [...new Set(jobLines(text))]
}

/**
 * What the sheet sends, for either mode.
 *
 * A whole-field patch: every field the sheet draws is here, because a key left out means "keep what
 * is stored", and the person is looking at what is stored. `id` is not here — the route keys on it,
 * and a changed one would orphan the job's log, history and secrets.
 */
export function jobFormPayload(form: JobForm): {
  label: string | null
  command: string
  args: string[]
  schedule: string
  cwd: string
  timeoutMs: number
  enabled: boolean
  secretEnv: string[]
} {
  const timeout = Number(form.timeoutSeconds.trim())
  return {
    // `null` clears it, so a display falls back to the id — the same rule the servers file uses.
    label: form.label.trim().length === 0 ? null : form.label.trim(),
    command: form.command.trim(),
    args: jobLines(form.args),
    schedule: form.schedule.trim(),
    cwd: form.cwd.trim().length === 0 ? '.' : form.cwd.trim(),
    timeoutMs: Number.isFinite(timeout) && timeout >= 1 ? Math.round(timeout) * 1000 : JOB_DEFAULT_TIMEOUT_SECONDS * 1000,
    enabled: form.enabled,
    secretEnv: jobSecretNames(form.secretEnv),
  }
}

/**
 * The **create** body: the patch, with a null `label` **omitted** rather than sent.
 *
 * `label: null` is legal on create (`labelOrNullSchema`) and writes `"label": null` into
 * `jobs.config.json` — a key with no value, where the file's own convention is to leave it out and let
 * a display fall back to the id. A patch keeps `null`, because there it means *clear it*.
 */
export function jobCreateBody(id: string, form: JobForm): Omit<ReturnType<typeof jobFormPayload>, 'label'> & { id: string, label?: string } {
  const { label, ...rest } = jobFormPayload(form)
  return label === null ? { id, ...rest } : { id, ...rest, label }
}

/** Whether the sheet can submit: the two the schema requires. */
export function jobFormComplete(form: JobForm, mode: 'create' | 'edit', id: string): boolean {
  const idOk = mode === 'edit' || id.trim().length > 0
  return idOk && form.command.trim().length > 0 && form.schedule.trim().length > 0
}

/** The id rules the panel enforces, checked here so a typo reads as a sentence, not a 400. */
export function jobIdProblem(id: string): string | null {
  const trimmed = id.trim()
  if (trimmed.length === 0)
    return 'an id is required — it names this job’s log, history and secret values'
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmed))
    return 'the id must start with a lowercase letter or digit, and hold only lowercase letters, digits, dash and underscore'
  return null
}
