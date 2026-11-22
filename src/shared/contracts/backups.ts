/**
 * Backups: the archive list, the capture tree, the restore plan and both request shapes.
 *
 * The view shapes and the request shapes travel together because they describe one operation from both
 * ends — what a page renders after a capture, and what it sends to start one — and a second declaration is
 * how the two drift.
 */
import { type } from 'arktype'
import { backupScheduleSchema } from '../contracts'
import { lazy } from '../lazy'
import { passwordValueSchema } from './accounts'

export const backupFileSchema = lazy(() => type({
  name: 'string',
  sizeBytes: 'number',
  createdAt: 'number',
  /** The archive carries a password-protected payload. */
  encrypted: 'boolean',
}))

export type BackupFile = typeof backupFileSchema.infer

/**
 * One selectable entry in a backup: a global item (`global:settings`,
 * `global:secrets`, `global:tls`) or a workspace, whose `items` are the
 * sub-choices a per-workspace dialog offers.
 */
export const backupEntrySchema = lazy(() => type({
  /** `global:settings` | `global:secrets` | `global:tls` | `workspace:<id>`. */
  'id': 'string',
  /**
   * The panel's own English wording. Kept because it is what an older UI reads, and what a
   * single-language UI wants; a translated UI prefers the `*Key` beside it.
   */
  'label': 'string',
  /** A catalog key for `label`, with its placeholder values, so a UI can render its own language. */
  'labelKey?': 'string',
  'labelParams?': 'Record<string, string>',
  'kind': '"settings" | "secrets" | "tls" | "workspace"',
  'workspaceId?': 'string',
  'note': 'string | null',
  /** The same pair for `note`: the panel knows which reason it is, the UI knows the wording. */
  'noteKey?': 'string',
  'noteParams?': 'Record<string, string>',
  /** What this entry would capture; a workspace carries several leaves. */
  'items': type({
    'id': 'string',
    'label': 'string',
    'labelKey?': 'string',
    'labelParams?': 'Record<string, string>',
    /** `settings`/`servers`/`secrets`/`jobs` for a workspace, `data` for a declared path. */
    'kind': '"settings" | "servers" | "secrets" | "jobs" | "data"',
    /** Which secret a `secrets` leaf carries (`password`, `apiToken`, `telegram`, `ddns`, …). */
    'secret?': 'string',
    'path?': 'string',
    /** Who declared a data path: `global`, `<serverId>:backupPaths` or `<serverId>:<ENV>`. */
    'origin?': 'string',
    'included': 'boolean',
    'note': 'string | null',
    'noteKey?': 'string',
    'noteParams?': 'Record<string, string>',
    'ignoreGenerated?': 'boolean',
  }).array(),
}))
export type BackupEntry = typeof backupEntrySchema.infer

/**
 * The schedule as a *response* carries it: undeclared keys are accepted, at both levels.
 *
 * A response schema may not reject (a newer panel may add a field an older client still reads), and
 * `scope` is one level deep — so the outer `.onUndeclaredKey` on the config schema is not enough:
 * a frame carrying `schedule.scope` rejected outright while this was the config shape.
 */
export const backupScheduleViewSchema = lazy(() => backupScheduleSchema.onDeepUndeclaredKey('ignore'))

export const backupsViewSchema = lazy(() => type({
  'enabled': 'boolean',
  'dir': 'string',
  'keep': 'number',
  /**
   * The scheduled half, so the page can show and edit it.
   *
   * Optional because the panel and the UI upgrade separately: an older panel does not send it,
   * and a required field would blank the settings page for that panel. The page reads it as
   * "off, keep 7" when absent — the schema defaults — so nothing changes for it.
   */
  'schedule?': backupScheduleViewSchema,
  /** When the last automatic archive was written; null until one has run. Optional for the same reason. */
  'lastAutomaticAt?': 'number | null',
  /**
   * Why the last scheduled pass failed, and when it tried.
   *
   * A failed pass wrote only a panel-console warning, so "enabled, zero archives" looked the same
   * as "failing every interval since the day it was enabled" — indistinguishable from the page,
   * which is the only place a person looks. Null once a pass succeeds.
   */
  'scheduleError?': type({
    message: 'string',
    at: 'number',
  }),
  /** Extra paths from the global config, in addition to each server's own. */
  'includePaths': type('string[]'),
  /**
   * The selection model, carried here only by a panel older than this release.
   *
   * Reading it costs a `readFileSync` of the global and every workspace's `.secrets.json` plus a
   * `statSync` per archive, and the state frame is rebuilt ~13×/s — so it moved to
   * `GET /api/backups` (`backupSelectionSchema`), which a dialog fetches when it opens. Optional on
   * purpose: a newer UI reads a panel that still sends it, and a UI must never reject a payload for
   * a field it does not use. Absent means "ask the endpoint".
   */
  'entries?': backupEntrySchema.array(),
  'files?': backupFileSchema.array(),
}))
export type BackupsView = typeof backupsViewSchema.infer

/**
 * The backup *selection model*: what a capture could include, and what is already on disk.
 *
 * Its own route rather than a field of the state frame, because building it reads every workspace's
 * secrets file and stats every archive — work proportional to workspaces × archives, on a path that
 * runs per frame. A dialog needs it when it opens and not otherwise.
 */
export const backupSelectionSchema = lazy(() => type({
  /** The archive directory, so a dialog can print the path without a second read. */
  dir: 'string',
  /** Every selectable entry, global first, then each workspace. */
  entries: backupEntrySchema.array(),
  files: backupFileSchema.array(),
}))
export type BackupSelection = typeof backupSelectionSchema.infer

/** One restorable slice of an archive: a global item, a workspace item, or a data path. */
export const restoreItemSchema = lazy(() => type({
  /** A backup entry or leaf id (`workspace:<id>:servers`, `data:<path>`, ...). */
  'id': 'string',
  'label': 'string',
  'labelKey?': 'string',
  'labelParams?': 'Record<string, string>',
  'kind': '"settings" | "secrets" | "servers" | "jobs" | "tls" | "data"',
  'workspaceId?': 'string',
  /** false when the current instance does not declare it, or it is not in the archive. */
  'restorable': 'boolean',
  /** Echo of the request's selection, so the checkboxes round-trip. */
  'selected': 'boolean',
  'note': 'string | null',
  'noteKey?': 'string',
  'noteParams?': 'Record<string, string>',
}))
export type RestoreItem = typeof restoreItemSchema.infer

/**
 * Why one thing was skipped, as a reason the UI can word itself.
 *
 * `skipped` stays a list of ready-made English sentences for an older UI and for
 * `noc-console`; this is the same list in parts, so a translated UI says it in the
 * reader's language instead of showing the panel's English inside its own sentence.
 */
export const restoreSkipSchema = lazy(() => type({
  'label': 'string',
  'labelKey?': 'string',
  'labelParams?': 'Record<string, string>',
  /** A catalog key for the parenthesis, e.g. `not selected`; absent when there is none. */
  'reasonKey?': 'string',
  'reasonParams?': 'Record<string, string>',
}))
export type RestoreSkip = typeof restoreSkipSchema.infer

export const restorePlanSchema = lazy(() => type({
  'dryRun': 'boolean',
  'encrypted': 'boolean',
  /** The archive needs a password (none or a wrong one was supplied). */
  'needsPassword': 'boolean',
  /**
   * Where the archive says it came from. Optional: an archive written before this
   * stamp existed carries neither field, and an older panel never sends the row.
   */
  'archive?': type({
    'writtenBy?': 'string',
    'schema?': 'number',
  }),
  'items': restoreItemSchema.array(),
  /**
   * One row per backup hook that ran, so a person can see which entries brought their own dump.
   *
   * Optional, like every new response field: an older panel never sends it and an older UI never
   * reads it. `output` is a bounded tail, not a log — enough to see what `mongorestore` said.
   */
  'hooks?': type({
    'serverId': 'string',
    'workspaceId': 'string',
    'action': '"dump" | "load"',
    'ok': 'boolean',
    'output?': 'string',
  }).array(),
  'applied': type('string[]'),
  /**
   * The ids `applied` names, so a UI resolves each through `items` and renders its own label.
   * `applied` itself stays: it is what a UI with one language reads.
   */
  'appliedIds?': type('string[]'),
  'skipped': type('string[]'),
  'skippedItems?': restoreSkipSchema.array(),
  /** Only the panel's own listener needs a restart; its servers are re-read live. */
  'restartRequired': 'boolean',
  /** The panel re-read the restored config within this same restore. */
  'reloaded': 'boolean',
  /**
   * Servers that are **running now** and whose declared data path this restore overwrote.
   *
   * A data path is copied over while its owner keeps running, holding open handles to files
   * that were just replaced — the process keeps its old view and the archive's copy wins on
   * disk, so anything written since the archive was taken is gone. The plan has to say which
   * entries that happened to, because nothing else in the result mentions them.
   *
   * Optional: an older panel does not send it, and a plan that touched no running entry sends none.
   */
  'replacedUnderRunning?': type({
    workspaceId: 'string',
    serverId: 'string',
    path: 'string',
  }).array(),
  /**
   * Workspaces this restore created because the archive named them and the host did not
   * have them. Optional: an older panel never sends the row, and an archive written
   * before the registry was captured creates none.
   */
  'createdWorkspaces?': type('string[]'),
  'error': 'string?',
}))
export type RestorePlan = typeof restorePlanSchema.infer

export const backupCreateSchema = lazy(() => type({
  /** Optional: encrypts the archive. Never stored. */
  password: passwordValueSchema.optional(),
  /** Leaf ids to capture (`global:settings`, `workspace:<id>:servers`, `data:<path>`, ...); omitted means everything. */
  include: type('string[] >= 1').optional(),
  /**
   * Leaf ids to leave out, applied after `include` — the CLI's `--exclude`, and the one thing to
   * name when the archive should carry everything but the credentials.
   *
   * Empty is refused for the same reason `include` refuses it: an empty list reads as "nothing" to
   * a person and as "everything" to a reader, so it must not be sent at all.
   */
  exclude: type('string[] >= 1').optional(),
}).onUndeclaredKey('reject'))
export type BackupCreate = typeof backupCreateSchema.infer

export const restoreRequestSchema = lazy(() => type({
  name: 'string?',
  password: passwordValueSchema.optional(),
  /** Item ids to restore; omitted means every restorable item. */
  include: type('string[]').optional(),
  /**
   * Item ids to leave out, applied after `include` — the CLI's `--exclude` on the same command.
   *
   * `BackupService.restore()` has always taken it and the local channel has always sent it, but this
   * schema declared only `name`/`password`/`include` **and rejects undeclared keys**, so the same
   * request over `/api` answered `exclude must be removed`: a script or either UI could only say
   * "these items", never "everything except these", on the one path that overwrites a live host.
   *
   * Empty is refused for the same reason it is on a create — it reads as "nothing" to a person and
   * as "everything" to the reader, so it must not be sent at all.
   */
  exclude: type('string[] >= 1').optional(),
}).onUndeclaredKey('reject'))
export type RestoreRequest = typeof restoreRequestSchema.infer
