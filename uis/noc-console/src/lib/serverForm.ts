import type { HealthConfig, OnPortConflict, RestartConfig, ServerConfig, ServerDefaults, StopConfig } from '@shared/contracts'
import type { HookForm, ServerEditForm } from '@shared/server-form'
import { healthSchema, restartSchema, serverSchema, stopSchema } from '@shared/contracts'
import { serverEditForm } from '@shared/server-form'

/**
 * The server form's shared half.
 *
 * `AddServerDialog.vue` and `ServerConfigView.vue` are the same form twice — a dialog
 * around it and a page around it. What lives here is the part that must not be written
 * twice: the defaults a form starts from, and the definition of every field both entry
 * points render. The entry points keep their shells (the sheet folds its advanced half
 * away, the page splits its halves into panes) and the parts only one of them has — the
 * sheet's `id` and its bootstrap group, the page's flat restart/health/stop panes. The
 * page's lifecycle panes are left alone on purpose: they edit 22 flat string boxes while
 * the sheet binds typed nested groups through `LifecycleFields.vue`, so that is one
 * policy in two representations rather than a copy of anything, and folding them
 * together would change how a value is entered.
 */

/**
 * The contract's own defaults, not a second hand-written literal.
 *
 * The dialog spelled these out, so a default that moved in `src/shared/contracts.ts`
 * left the form diffing against a value the panel no longer had — and the diff then
 * writes that stale default into `servers.config.json`. Asking the schema is the one
 * implementation of "what is the default"; `test/server-form.test.ts` pins the values it
 * produces against the literals it replaced.
 */
export const SCHEMA_RESTART: RestartConfig = restartSchema.assert({})
export const SCHEMA_HEALTH: HealthConfig = healthSchema.assert({})
export const SCHEMA_STOP: StopConfig = stopSchema.assert({})

/** A detached copy: a shallow one would alias the nested `http` group to live state. */
export function cloneHealth(health: HealthConfig): HealthConfig {
  return { ...health, http: { ...health.http } }
}

/**
 * What an entry would inherit if the body said nothing about it: the schema's own
 * defaults, with the panel's `Settings → Server defaults` on top.
 *
 * One definition, because the dialog's create-diff and the page's edit both reason about
 * "unchanged" in these terms; two copies is how one of them starts freezing values the
 * other still inherits.
 */
export function inheritBaseline(defaults: ServerDefaults | null): Record<string, unknown> {
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
    persistent: false,
    onPortConflict: defaults?.onPortConflict ?? 'block',
    logBufferLines: defaults?.logBufferLines ?? 500,
  }
}

export type FormVariant = 'sheet' | 'page'

/**
 * Every field either entry point renders, under the name its own form object already
 * carries. Numeric fields are text on purpose: a cleared box has to be distinguishable
 * from a zero, and `repairNumbers` turns it back into the live value. `liveBind` is a
 * readout rather than a value, and `customBind` belongs to the page's bind select.
 */
export type FieldKey
  = | 'id' | 'label' | 'command' | 'args' | 'cwd' | 'port' | 'bind' | 'customBind'
    | 'enabled' | 'autostart' | 'persistent' | 'onPortConflict' | 'logBufferLines'
    | 'liveBind' | 'dependsOn' | 'maxRssMb' | 'envFile'
    | 'env' | 'dataEnvs' | 'backupPaths' | 'backupIgnoreGenerated'
    | 'bootstrapEnabled' | 'bootstrapCommand' | 'bootstrapTimeoutSeconds' | 'bootstrapRunOnce'
    | 'bootstrapArgs' | 'bootstrapEnv'
    | 'dumpEnabled' | 'dumpCommand' | 'dumpTimeoutSeconds' | 'dumpArgs' | 'dumpEnv'
    | 'loadEnabled' | 'loadCommand' | 'loadTimeoutSeconds' | 'loadArgs' | 'loadEnv'

export type FieldValue = string | boolean

/** What a form carries: the fields it has, and no promise that it has all of them. */
export type FormModel = Partial<Record<FieldKey, FieldValue>>

/**
 * The fields both entry points carry, as a form object.
 *
 * The two disagree in exactly three of them, and each disagreement is deliberate: the
 * sheet writes `cwd`, `logBufferLines` and `bootstrapTimeoutSeconds` blank so its placeholder
 * can say what will be inherited, while the page shows the value it is actually editing
 * and must start from the panel default. Everything else is one value, so it is written
 * once; `test/server-form.test.ts` pins all three per variant.
 */
export function blankSharedForm(variant: FormVariant, defaults?: ServerDefaults | null): Omit<ServerFormShape, 'customBind'> {
  const sheet = variant === 'sheet'
  return {
    label: '',
    command: '',
    args: '',
    cwd: sheet ? '' : '.',
    port: '',
    bind: defaults?.bind ?? 'local',
    enabled: defaults?.enabled ?? true,
    autostart: defaults?.autostart ?? false,
    persistent: false,
    env: '',
    dataEnvs: '',
    backupPaths: '',
    backupIgnoreGenerated: true,
    dependsOn: '',
    envFile: '',
    maxRssMb: '',
    onPortConflict: defaults?.onPortConflict ?? 'block',
    logBufferLines: sheet ? '' : '500',
    bootstrapEnabled: false,
    bootstrapCommand: '',
    bootstrapArgs: '',
    bootstrapEnv: '',
    bootstrapTimeoutSeconds: sheet ? '' : '120',
    bootstrapRunOnce: true,
  }
}

/** The fields the two entry points share, under the names their form objects use. */
interface ServerFormShape {
  label: string
  command: string
  args: string
  cwd: string
  port: string
  bind: string
  customBind: string
  enabled: boolean
  autostart: boolean
  persistent: boolean
  env: string
  dataEnvs: string
  backupPaths: string
  backupIgnoreGenerated: boolean
  dependsOn: string
  envFile: string
  maxRssMb: string
  onPortConflict: OnPortConflict
  logBufferLines: string
  bootstrapEnabled: boolean
  bootstrapCommand: string
  bootstrapArgs: string
  bootstrapEnv: string
  /** Seconds: the schema floor is 1000 ms. */
  bootstrapTimeoutSeconds: string
  bootstrapRunOnce: boolean
}

/** A MiB box as the bytes the config stores; an empty box means "no guard". */
export function rssBytesFromForm(value: string): number {
  const megabytes = value.trim()
  return megabytes === '' ? 0 : Math.round(Number(megabytes) * 1024 * 1024)
}

/** Stored bytes back into the MiB box; 0 is blank, not "0". */
export function rssMegabytesFromConfig(bytes: number): string {
  return bytes > 0 ? String(Math.round(bytes / 1024 / 1024)) : ''
}

export interface FieldSpec {
  label: string
  control: 'text' | 'textarea' | 'select' | 'check' | 'readonly'
  hint?: string
  placeholder?: string
  rows?: number
  required?: boolean
  /** `inputmode="numeric"` on a box that is still a string, so a cleared one stays `''`. */
  numeric?: boolean
  /** `grid__full`: the field spans every column. */
  full?: boolean
  options?: Array<{ value: string, label: string }>
  /** A hook box, disabled until its section's own toggle is on. */
  enabledBy?: 'bootstrapEnabled' | 'dumpEnabled' | 'loadEnabled'
  /** `:placeholder="`inherited (N)`"`, from the workspace's own `logBufferLines`. */
  inheritedPlaceholder?: boolean
  /** The page's explicit-IPv4 box, shown only while `bind` is `custom`. */
  whenCustomBind?: boolean
}

const CONFLICT_OPTIONS = ['block', 'warn', 'follow', 'reclaim', 'kill']
  .map(value => ({ value, label: value }))

/**
 * A field is defined **once**, wherever the two entry points agree. Most of them agree
 * completely, so they appear only here; the rest carry an override below with just what
 * differs.
 */
/**
 * The fields the two entry points render identically, spelled once each.
 *
 * A field they word differently is deliberately absent here and declared in `SHEET`/`PAGE`
 * below — a common entry both variants then override is dead weight that still reads as
 * authoritative. `satisfies Partial<…>` keeps the keys literal, so the two variant maps can
 * be checked for completeness against them; a field landing in none of the three is a
 * compile error rather than a blank label.
 */
const COMMON = {
  id: { label: 'id', control: 'text', placeholder: 'my-server', required: true },
  label: { label: 'label', control: 'text', placeholder: 'falls back to the id' },
  cwd: { label: 'cwd', control: 'text', placeholder: '.' },
  customBind: { label: 'ipv4 address', control: 'text', placeholder: '192.168.1.10', whenCustomBind: true },
  enabled: { label: 'enabled', control: 'check' },
  autostart: { label: 'autostart with up', control: 'check' },
  onPortConflict: { label: 'on port conflict', control: 'select', options: CONFLICT_OPTIONS },
  liveBind: { label: 'live bind address', control: 'readonly' },
  env: { label: 'env — KEY=value per line', control: 'textarea', rows: 3, full: true },
  dataEnvs: {
    label: 'data envs — ENV=path per line',
    control: 'textarea',
    rows: 3,
    placeholder: 'DATA_DIR={home}/.app',
    hint: 'exported to the process and picked up by backups automatically',
    full: true,
  },
  backupPaths: { label: 'extra backup paths — one per line', control: 'textarea', rows: 2, placeholder: '{home}/.app/uploads', full: true },
  backupIgnoreGenerated: {
    label: 'ignore known generated files when backing this up',
    control: 'check',
    hint: 'node_modules, dist, .next, caches — nothing restores from them',
    full: true,
  },
  bootstrapEnabled: { label: 'run before the first start', control: 'check' },
  bootstrapRunOnce: { label: 'once per up session', control: 'check', enabledBy: 'bootstrapEnabled' },
  bootstrapArgs: { label: 'args — one per line', control: 'textarea', rows: 2, enabledBy: 'bootstrapEnabled', full: true },
  bootstrapEnv: { label: 'env — KEY=value per line', control: 'textarea', rows: 2, enabledBy: 'bootstrapEnabled', full: true },
  dumpEnabled: { label: 'dump before a backup', control: 'check', hint: 'a failed dump refuses the backup' },
  dumpCommand: { label: 'command', control: 'text', placeholder: 'mongodump', enabledBy: 'dumpEnabled' },
  dumpTimeoutSeconds: { label: 'timeout (s)', control: 'text', numeric: true, enabledBy: 'dumpEnabled' },
  dumpArgs: { label: 'args — one per line', control: 'textarea', rows: 2, hint: '--archive={dumpDir}/db.archive writes into the directory the archive carries', enabledBy: 'dumpEnabled', full: true },
  dumpEnv: { label: 'env — KEY=value per line', control: 'textarea', rows: 2, enabledBy: 'dumpEnabled', full: true },
  loadEnabled: { label: 'load after a restore', control: 'check', hint: 'runs on the entry’s next start, reading from {dumpDir}' },
  loadCommand: { label: 'command', control: 'text', placeholder: 'mongorestore', enabledBy: 'loadEnabled' },
  loadTimeoutSeconds: { label: 'timeout (s)', control: 'text', numeric: true, enabledBy: 'loadEnabled' },
  loadArgs: { label: 'args — one per line', control: 'textarea', rows: 2, enabledBy: 'loadEnabled', full: true },
  loadEnv: { label: 'env — KEY=value per line', control: 'textarea', rows: 2, enabledBy: 'loadEnabled', full: true },
} satisfies Partial<Record<FieldKey, FieldSpec>>
/**
 * What the sheet spells differently. A key here **replaces** its common entry outright,
 * so each override reads as the whole field rather than a diff against a definition two
 * screens up. The differences are wording, the odd control kind, and which hint each side
 * chose to show — never what the field means.
 */
type DifferingKey = Exclude<FieldKey, keyof typeof COMMON>

/** What the sheet words differently, and the fields only it places. */
const SHEET: Record<DifferingKey, FieldSpec> = {
  command: { label: 'command', control: 'text', placeholder: 'node', required: true, full: true },
  args: {
    label: 'args — space separated',
    control: 'text',
    placeholder: '-p {port} -H {host}',
    hint: 'placeholders: {port} {host} {home} {projectDir} {dataRoot} {id} {label} {cwd} {bind} {lanIp}',
    full: true,
  },
  port: { label: 'port', control: 'text', numeric: true, placeholder: 'empty = none' },
  bind: { label: 'bind', control: 'select', options: [{ value: 'local', label: 'local (127.0.0.1)' }, { value: 'lan', label: 'lan (0.0.0.0)' }, { value: 'custom', label: 'custom ipv4' }] },
  persistent: { label: 'persistent', control: 'check', hint: 'keeps running when the panel stops; `down` reports it instead of stopping it' },
  logBufferLines: { label: 'log buffer lines', control: 'text', numeric: true, inheritedPlaceholder: true },
  dependsOn: { label: 'depends on — comma separated ids', control: 'text', placeholder: 'db, cache' },
  maxRssMb: { label: 'max rss (MiB)', control: 'text', numeric: true, placeholder: 'empty = no guard' },
  envFile: { label: 'env file', control: 'text', placeholder: 'empty = none' },
  bootstrapCommand: { label: 'command', control: 'text', placeholder: './scripts/install.sh', enabledBy: 'bootstrapEnabled' },
  bootstrapTimeoutSeconds: { label: 'timeout (s)', control: 'text', numeric: true, placeholder: '120', enabledBy: 'bootstrapEnabled' },
}
/** What the page spells differently from the sheet, field by field. */
/** What the page words differently, and the fields only it places. */
const PAGE: Record<DifferingKey, FieldSpec> = {
  command: { label: 'command', control: 'text', required: true },
  args: {
    label: 'args — one per line, placeholders allowed',
    control: 'textarea',
    rows: 4,
    hint: '{port} {host} {home} {projectDir} {dataRoot} {id} {label} {cwd} {bind} {lanIp}',
    full: true,
  },
  port: { label: 'port', control: 'text', numeric: true, placeholder: 'empty = no port', hint: 'no port means no readiness probe and no health supervision' },
  bind: {
    label: 'bind',
    control: 'select',
    options: [{ value: 'local', label: 'local · 127.0.0.1' }, { value: 'lan', label: 'lan · 0.0.0.0' }, { value: 'custom', label: 'custom ipv4' }],
  },
  persistent: { label: 'persistent', control: 'check', hint: 'keeps running when the panel stops; stop it explicitly to end it' },
  logBufferLines: { label: 'log buffer lines', control: 'text', numeric: true },
  dependsOn: {
    label: 'depends on — comma separated ids',
    control: 'text',
    placeholder: 'db, cache',
    hint: 'started first (and healthy); stopped last — after anything that depends on it',
    full: true,
  },
  maxRssMb: { label: 'max rss (MiB)', control: 'text', numeric: true, placeholder: 'empty = no guard', hint: 'restart when the process tree exceeds it' },
  envFile: { label: 'env file', control: 'text', placeholder: 'empty = none', hint: 'loaded at spawn; its values override env' },
  bootstrapCommand: { label: 'command', control: 'text', enabledBy: 'bootstrapEnabled' },
  bootstrapTimeoutSeconds: { label: 'timeout (s)', control: 'text', numeric: true, enabledBy: 'bootstrapEnabled' },
}
/**
 * The fields, resolved: the common definition under whatever that variant overrides.
 *
 * Built by spreading, so a field the two entry points agree on is written once and a
 * field they do not is written once per variant.
 */
export const FIELD_SPECS: Record<FormVariant, Record<FieldKey, FieldSpec>> = {
  sheet: { ...COMMON, ...SHEET },
  page: { ...COMMON, ...PAGE },
}

/**
 * The catalogue's three parts, exposed so a test can check the split itself.
 *
 * The types already prove the split is *total* — `Record<DifferingKey, FieldSpec>` fails to
 * compile if a field is missing from a variant. They cannot prove it is *disjoint*, and a
 * field left in `COMMON` that both variants also declare is the dangerous half: it never
 * renders, yet it reads as that field's definition and is what a future edit would change.
 */
export const FIELD_CATALOG_PARTS = { common: COMMON, sheet: SHEET, page: PAGE }

/**
 * One block of the form, as the shared renderer draws it.
 *
 * `grid` is a bare field grid, `group` and `pane` add the titled shell each product already
 * uses, `fold` is the sheet's `<details>` around the blocks in `sections`, and `lifecycle`
 * is a marker where the entry point puts its own restart/health/stop markup. `toggle` is
 * the block's own on/off switch, drawn in its head rather than among its fields.
 */
export interface FormSection {
  container: 'grid' | 'group' | 'pane' | 'fold' | 'lifecycle'
  title?: string
  toggle?: FieldKey
  fields: FieldKey[]
  /** A `fold`'s blocks. One level is enough: only the sheet folds. */
  sections?: FormSection[]
  /** The sentence above a `fold`'s blocks. */
  note?: string
}

/**
 * Which fields each entry point shows, in what order, and in which shell — the layout both
 * now read instead of each re-typing.
 *
 * It is shared because it is the same form: the sheet puts the policy fields behind one
 * fold, the page spreads them over panes, and neither is free to forget a field the other
 * offers, which is what happened when the `dependsOn` hint drifted between them.
 */
export const FORM_LAYOUT: Record<FormVariant, FormSection[]> = {
  sheet: [
    { container: 'grid', fields: ['id', 'label', 'command', 'args', 'cwd', 'port', 'bind', 'customBind', 'autostart', 'persistent'] },
    {
      container: 'fold',
      fields: [],
      note: 'restart, health, stop and bootstrapping start equal to the panel defaults — change a group to write it into this entry; leave it alone and it keeps inheriting.',
      sections: [
        {
          container: 'grid',
          fields: ['enabled', 'onPortConflict', 'logBufferLines', 'maxRssMb', 'envFile', 'dependsOn', 'env', 'dataEnvs', 'backupPaths', 'backupIgnoreGenerated'],
        },
        { container: 'lifecycle', fields: [] },
        {
          container: 'group',
          title: 'bootstrap',
          toggle: 'bootstrapEnabled',
          fields: ['bootstrapCommand', 'bootstrapTimeoutSeconds', 'bootstrapRunOnce', 'bootstrapArgs', 'bootstrapEnv'],
        },
      ],
    },
  ],
  page: [
    { container: 'pane', title: 'process', fields: ['label', 'command', 'cwd', 'envFile', 'args', 'env', 'dataEnvs', 'backupPaths', 'backupIgnoreGenerated'] },
    {
      container: 'pane',
      title: 'port & binding',
      fields: ['port', 'bind', 'customBind', 'onPortConflict', 'logBufferLines', 'liveBind', 'enabled', 'autostart', 'persistent', 'dependsOn'],
    },
    { container: 'lifecycle', fields: [] },
    { container: 'pane', title: 'resources', fields: ['maxRssMb'] },
    {
      container: 'pane',
      title: 'bootstrap',
      toggle: 'bootstrapEnabled',
      fields: ['bootstrapCommand', 'bootstrapTimeoutSeconds', 'bootstrapRunOnce', 'bootstrapArgs', 'bootstrapEnv'],
    },
    {
      container: 'pane',
      title: 'backup dump',
      toggle: 'dumpEnabled',
      fields: ['dumpCommand', 'dumpTimeoutSeconds', 'dumpArgs', 'dumpEnv'],
    },
    {
      container: 'pane',
      title: 'restore load',
      toggle: 'loadEnabled',
      fields: ['loadCommand', 'loadTimeoutSeconds', 'loadArgs', 'loadEnv'],
    },
  ],
}

/**
 * The one place a renderer reaches a field's definition, rather than rebuilding it.
 *
 * This is the whole entry, layout flags included: a renderer decides where a field goes
 * and when it is inert from these.
 */
export function fieldSpec(variant: FormVariant, key: FieldKey): FieldSpec {
  return FIELD_SPECS[variant][key]
}

/** What is actually *drawn* — the entry minus the flags that placed it. */
export interface FieldPresentation {
  label: string
  control: FieldSpec['control']
  hint?: string
  placeholder?: string
  rows?: number
  required?: boolean
  numeric?: boolean
  full?: boolean
  options?: Array<{ value: string, label: string }>
}

/**
 * A field as a prop bag for the field component.
 *
 * Returning the drawn properties rather than the whole spec keeps `v-bind` honest: the
 * layout flags would otherwise fall through onto the rendered element as stray
 * attributes, and this is also what lets the component's props stay a closed list.
 */
export function fieldPresentation(variant: FormVariant, key: FieldKey): FieldPresentation {
  const spec = FIELD_SPECS[variant][key]
  return {
    label: spec.label,
    control: spec.control,
    hint: spec.hint,
    placeholder: spec.placeholder,
    rows: spec.rows,
    required: spec.required,
    numeric: spec.numeric,
    full: spec.full,
    options: spec.options,
  }
}

/**
 * The page's form: the shared fields as the strings its boxes hold, the dump/load hooks, and the
 * typed lifecycle groups its own panes bind (their boxes write strings into them).
 *
 * The round trip itself — what a cleared box means, seconds, the diff — is
 * `@shared/server-form`, the one `uis/stock`'s editor reads; this only translates the shape.
 */
/** What the page's form holds before its entry has arrived in a frame: the schema's defaults. */
export const PLACEHOLDER_CONFIG = serverSchema.assert({ id: 'placeholder', command: 'placeholder' }) as ServerConfig

export type PageForm = ServerFormShape & {
  dumpEnabled: boolean
  dumpCommand: string
  dumpTimeoutSeconds: string
  dumpArgs: string
  dumpEnv: string
  loadEnabled: boolean
  loadCommand: string
  loadTimeoutSeconds: string
  loadArgs: string
  loadEnv: string
  restart: ServerEditForm['restart']
  health: ServerEditForm['health']
  stop: ServerEditForm['stop']
}

function text(value: unknown): string {
  return value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value)) ? '' : String(value)
}

/** A config as the page's boxes show it. */
export function pageFormFrom(config: ServerConfig): PageForm {
  const edit = serverEditForm(config)
  const standard = edit.bind === 'local' || edit.bind === 'lan'
  return {
    label: edit.label,
    command: edit.command,
    args: edit.args,
    cwd: edit.cwd,
    env: edit.env,
    dataEnvs: edit.dataEnvs,
    backupPaths: edit.backupPaths,
    backupIgnoreGenerated: edit.backupIgnoreGenerated,
    dependsOn: edit.dependsOn,
    envFile: edit.envFile,
    maxRssMb: text(edit.maxRssMb),
    port: text(edit.port),
    bind: standard ? edit.bind : 'custom',
    customBind: standard ? '' : edit.bind,
    onPortConflict: edit.onPortConflict,
    logBufferLines: text(edit.logBufferLines),
    enabled: edit.enabled,
    autostart: edit.autostart,
    persistent: edit.persistent,
    bootstrapEnabled: edit.bootstrap.enabled,
    bootstrapCommand: edit.bootstrap.command,
    bootstrapArgs: edit.bootstrap.args,
    bootstrapEnv: edit.bootstrap.env,
    bootstrapTimeoutSeconds: text(edit.bootstrap.timeoutSeconds),
    bootstrapRunOnce: edit.bootstrap.runOnce,
    dumpEnabled: edit.dump.enabled,
    dumpCommand: edit.dump.command,
    dumpTimeoutSeconds: text(edit.dump.timeoutSeconds),
    dumpArgs: edit.dump.args,
    dumpEnv: edit.dump.env,
    loadEnabled: edit.load.enabled,
    loadCommand: edit.load.command,
    loadTimeoutSeconds: text(edit.load.timeoutSeconds),
    loadArgs: edit.load.args,
    loadEnv: edit.load.env,
    restart: edit.restart,
    health: edit.health,
    stop: edit.stop,
  }
}

function hook(form: PageForm, prefix: 'dump' | 'load'): HookForm {
  return {
    enabled: form[`${prefix}Enabled`],
    command: form[`${prefix}Command`],
    args: form[`${prefix}Args`],
    env: form[`${prefix}Env`],
    timeoutSeconds: form[`${prefix}TimeoutSeconds`],
  }
}

/** The page's boxes as the shared form, for the shared payload and diff. */
export function editFormFromPage(form: PageForm): ServerEditForm {
  return {
    label: form.label,
    command: form.command,
    cwd: form.cwd,
    args: form.args,
    env: form.env,
    dataEnvs: form.dataEnvs,
    backupPaths: form.backupPaths,
    backupIgnoreGenerated: form.backupIgnoreGenerated,
    dependsOn: form.dependsOn,
    envFile: form.envFile,
    maxRssMb: form.maxRssMb,
    port: form.port,
    bind: form.bind === 'custom' ? form.customBind : form.bind,
    onPortConflict: form.onPortConflict,
    logBufferLines: form.logBufferLines,
    enabled: form.enabled,
    autostart: form.autostart,
    persistent: form.persistent,
    restart: form.restart,
    health: form.health,
    stop: form.stop,
    bootstrap: {
      enabled: form.bootstrapEnabled,
      command: form.bootstrapCommand,
      args: form.bootstrapArgs,
      env: form.bootstrapEnv,
      timeoutSeconds: form.bootstrapTimeoutSeconds,
      runOnce: form.bootstrapRunOnce,
    },
    dump: hook(form, 'dump'),
    load: hook(form, 'load'),
  }
}
