import type { SecretScope } from '#src/config/secret-parts'
import type { TemplateVars } from '#src/helpers/template'
import type { BackupEntry, BackupFile, BackupsConfig, BackupSelection, BackupsView, RestoreItem, RestorePlan, RestoreSkip, ServerConfig } from '#src/shared/contracts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DetailedError } from '@namesmt/utils'
import { type } from 'arktype'
import { applyConfigMigrations, CONFIG_SCHEMA, planConfigMigrations } from '#src/config/migrations'
import { parseGlobalSettings, parseServersFile, parseWorkspaceSettings, stampConfig } from '#src/config/parse'
import { KNOWN_SECRET_KEYS, mergeSecrets, parseSecrets, pickSecrets, presentSecretKeys, secretParts } from '#src/config/secret-parts'
import { workspacesFileSchema } from '#src/config/workspaces'
import { writeFileAtomic } from '#src/helpers/atomic'
import { expandEnv } from '#src/helpers/env-file'
import { logger } from '#src/helpers/logger'
import { projectDir, resolveUserPath } from '#src/helpers/paths'
import { acquireRestoreLock } from '#src/helpers/restore-lock'
import { resolveTemplate } from '#src/helpers/template'
import { appVersion } from '#src/helpers/version'
import { createZip, extractZip, isInvalidPassword, isZipArchive, listZip } from '#src/providers/archive'
import { hookFailure, runBackupHook } from '#src/providers/backup-hook'
import { serverTemplateVars } from '#src/services/supervisor'
import { scopeSelection, selectionOf } from '#src/shared/backup-scope'
import { workspaceIdSchema } from '#src/shared/contracts'
import { errorMessage } from '#src/shared/error-message'
import { isGeneratedPath } from '#src/shared/generated'
import { isRecord } from '#src/shared/shape'

const MANIFEST = 'manifest.json'
/**
 * The workspace registry inside an archive. Under `global/` because it is panel-wide, and
 * named as the live file is, so the two are recognisably the same document.
 */
const REGISTRY = 'workspaces.json'
const ALLOWED_ROOTS = new Set(['global', 'workspaces', 'data', 'dumps'])
/** Every archive this service writes is a zip, encrypted or not. */
const SUFFIX = '.zip'
/** Where a restore parks a dump until the entry's next start can load it. */
const PENDING_LOAD = 'pending-load'
/**
 * An archive the schedule wrote. The prefix is the only durable marker: a filename is the one
 * thing that survives a restart, and it is what lets the two retention counts stay independent.
 */
const AUTO_PREFIX = 'auto'
/** A workspace leaf that carries state the panel re-reads after a restore. */
const RELOADABLE = /^global:settings$|^workspace:[^:]+:(?:settings|servers)$/

/**
 * The English wording and catalog key of each known secret. A key missing here is still
 * selectable and restorable — it just reads as its own name, which is what keeps a
 * secret added by a later release from being silently uncapturable.
 */
const SECRET_LABELS: Record<string, { en: string, key: string }> = {
  password: { en: 'Password', key: 'settings.backup.secretPassword' },
  apiToken: { en: 'API token', key: 'settings.backup.secretApiToken' },
  telegram: { en: 'Telegram bot token', key: 'settings.backup.secretTelegram' },
  ddns: { en: 'DDNS credentials', key: 'settings.backup.secretDdns' },
}

/**
 * Structural allowlist for archive entries. A regex alone is not enough: `..`
 * is made of allowed characters, so segments are checked explicitly and any
 * entry that could resolve outside the staging directory aborts the restore.
 */
/**
 * The servers an archive carries for one workspace, from its staged config.
 *
 * A restore reads this rather than `getSources()` because the live config is the *old* one at this
 * point: the files have just been overwritten, and the hooks to run belong to the machine being
 * cloned. A config that will not parse yields no servers, so the caller reports a missing hook
 * rather than throwing.
 */
function readArchivedServers(staging: string, workspaceId: string, defaults: Record<string, unknown> = {}): ServerConfig[] {
  const text = readText(path.join(staging, 'workspaces', workspaceId, 'servers.config.json'))
  if (text === null)
    return []
  try {
    // `parseServersFile`, not `JSON.parse`: a raw config carries no `bind`, `restart` or `health`,
    // and the template vars read `bind` — parsing by hand threw for every entry, which is why the
    // load hook silently never ran.
    return parseServersFile(JSON.parse(text), defaults).servers
  }
  catch {
    return []
  }
}

/**
 * Whether one archive path segment is a name a filesystem will accept as-is.
 *
 * A separator moves the path, and `\` is a separator on Windows while an archive crosses platforms;
 * `:` re-roots or opens a stream there. A control character is never a real filename and is how an
 * extractor is confused. Everything else — spaces, non-ASCII, `&`, `$`, `#`, `@` — is what a data
 * directory actually contains.
 */
function isPortableSegment(segment: string): boolean {
  for (const character of segment) {
    const code = character.codePointAt(0) ?? 0
    if (character === '\\' || character === ':' || code < 0x20 || code === 0x7F)
      return false
  }
  return true
}

export function isSafeArchiveEntry(entry: string): boolean {
  if (entry.startsWith('/') || entry.includes('\0'))
    return false

  const cleaned = entry.replace(/^\.\//, '').replace(/\/+$/, '')
  if (cleaned.length === 0)
    return true
  if (cleaned === MANIFEST)
    return true

  const segments = cleaned.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..'))
    return false
  if (!ALLOWED_ROOTS.has(segments[0]!))
    return false
  // Not a character allowlist: a backup captures whatever the declared tree holds, and
  // `My Photos/` or `ünïcode/日本語.txt` are ordinary names in it. A `\w` rule refused the archive
  // this panel had just written, so a restore onto a blank host — the one restore nobody can check
  // by eye — died on "unexpected entries" with nothing wrong with the archive. What must be refused
  // is a segment that could *move* the path: a separator (`\` is one on Windows, and an archive
  // crosses platforms), a control character, or a drive/stream marker.
  return segments.every(isPortableSegment)
}

/**
 * The gates an archive passes before anything plans a restore from it: it is a zip at all, and
 * every entry in it is inside the layout this service writes.
 *
 * One function because there are two doors — an uploaded archive (`POST /api/backups/restore`,
 * multipart) and `backup restore --from <path>` — and the entry allowlist is the boundary that
 * stops a crafted archive writing outside the layout. A door that forgets one of these gates is
 * the defect this exists to prevent.
 *
 * The archive's **location** is not part of this. A restore reads the file it is given and writes
 * only to a fresh staging directory plus the paths the live config declares, so where the readable
 * bytes came from cannot widen what a restore may write — an arbitrary path adds a read the caller
 * already had, not a write target.
 */
export type ArchiveAdmission
  = | { ok: true, entries: Awaited<ReturnType<typeof listZip>> }
    | { ok: false, error: string }

export async function admitArchive(archivePath: string): Promise<ArchiveAdmission> {
  if (!isZipArchive(archivePath))
    return { ok: false, error: 'the archive is not a home-hosted backup (a zip file was expected)' }

  // The central directory is readable without a password, so a backup can be listed and its
  // selection offered before the password is ever entered.
  let entries: Awaited<ReturnType<typeof listZip>>
  try {
    entries = await listZip(archivePath)
  }
  catch (error) {
    return { ok: false, error: `the archive could not be read: ${errorMessage(error)}` }
  }

  if (entries.length === 0)
    return { ok: false, error: 'the archive is empty' }
  if (entries.length > 100_000)
    return { ok: false, error: 'the archive has too many entries' }

  const invalid = entries.filter(entry => !isSafeArchiveEntry(entry.name))
  if (invalid.length > 0)
    return { ok: false, error: `the archive contains unexpected entries (e.g. ${invalid.slice(0, 3).map(entry => entry.name).join(', ')})` }

  return { ok: true, entries }
}

/** True when `child` is `parent` itself or lives underneath it. */
export function isInside(parent: string, child: string): boolean {
  if (parent === child)
    return true
  // `path.relative` is case-insensitive on Windows, and empty for a case-only
  // difference — which is still the same directory.
  const relative = path.relative(parent, child)
  return !path.isAbsolute(relative) && (relative.length === 0 || !relative.startsWith('..'))
}

/** Resolves symlinks on the deepest existing ancestor, keeping the rest verbatim. */
function resolveExisting(target: string): string {
  let prefix = target
  const rest: string[] = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(prefix), ...rest)
    }
    catch {
      const parent = path.dirname(prefix)
      if (parent === prefix)
        return target
      rest.unshift(path.basename(prefix))
      prefix = parent
    }
  }
}

/**
 * `isInside` after resolving symlinks, so a link inside a declared path cannot stand
 * for somewhere else. `cpSync` follows links already present in the tree it writes
 * into* — a link to an uploads or cache directory is routine — which would let an
 * archive write outside the path the config declared, and on capture let a file from
 * outside it into the archive. Both sides check with this.
 */
export function isInsideResolved(parent: string, child: string): boolean {
  // Both sides go through `resolveExisting`, so a symlinked ancestor of either — `/var`
  // on macOS, a symlinked home — cancels out instead of making the comparison
  // asymmetric and rejecting a legitimate target.
  return isInside(resolveExisting(path.resolve(parent)), resolveExisting(path.resolve(child)))
}

/** One declared data path, with the verdict the UI shows. */
export interface BackupPath {
  path: string
  origin: string
  included: boolean
  note: string | null
  /**
   * The verdict as a catalog key, so a translated UI words it itself.
   *
   * The panel is the only side that knows *why* a path is excluded; the UI is the only side that
   * knows what language to say it in. `note` stays for an older UI and for `noc-console`.
   */
  noteKey?: string
  noteParams?: Record<string, string>
  ignoreGenerated: boolean
}

/** The `{…}` placeholders a *global* declared path may use. */
export interface BackupVars {
  projectDir: string
  dataRoot: string
  home: string
}

interface DeclaredPath {
  path: string
  origin: string
  depth: number
  order: number
  ignoreGenerated: boolean
}

/**
 * Every path a backup should capture: the global list, then each server's
 * `backupPaths` and the values of its `dataEnvs`. A path already covered by a
 * declared parent is reported but not captured, so an entry only has to name
 * the shallowest directory it cares about.
 *
 * `vars` only feeds the global list; a server's own placeholders come from its
 * resolved config, exactly as the supervisor expands them.
 */
export function resolveBackupPaths(servers: ServerConfig[], includePaths: string[] = [], vars?: Partial<BackupVars>): BackupPath[] {
  const declared: DeclaredPath[] = []
  const globalVars: TemplateVars = {
    projectDir: vars?.projectDir ?? projectDir,
    // A server carries the panel's real `dataRoot`; the fallback keeps this
    // function usable on its own when nothing declared a server path.
    dataRoot: vars?.dataRoot ?? (servers[0] === undefined ? projectDir : String(serverTemplateVars(servers[0]).dataRoot ?? projectDir)),
    home: vars?.home ?? os.homedir(),
  }

  const add = (value: string, origin: string, templateVars: TemplateVars, ignoreGenerated: boolean): void => {
    if (value.trim().length === 0)
      return
    // Normalized, so a trailing slash or a doubled one cannot defeat the
    // parent/child comparison below.
    const resolved = path.normalize(resolveUserPath(expandEnv(resolveTemplate(value, templateVars), process.env)))
    declared.push({
      path: resolved,
      origin,
      depth: path.normalize(resolved).split(path.sep).filter(Boolean).length,
      order: declared.length,
      ignoreGenerated,
    })
  }

  // A global extra path is named by hand, so it is captured as it stands.
  for (const value of includePaths) add(value, 'global', globalVars, false)

  for (const config of servers) {
    const templateVars = serverTemplateVars(config)
    const ignoreGenerated = config.backupIgnoreGenerated !== false
    for (const [name, value] of Object.entries(config.dataEnvs)) add(value, `${config.id}:${name}`, templateVars, ignoreGenerated)
    for (const value of config.backupPaths) add(value, `${config.id}:backupPaths`, templateVars, ignoreGenerated)
  }

  // Shallowest first, so a parent always absorbs its descendants whatever order
  // the config declared them in; ties keep declaration order.
  const sorted = [...declared].sort((a, b) => a.depth - b.depth || a.order - b.order)

  return sorted.map((entry, index) => {
    const parent = sorted.slice(0, index).find(candidate => isInside(candidate.path, entry.path))
    if (parent === undefined)
      return { path: entry.path, origin: entry.origin, included: true, note: null, ignoreGenerated: entry.ignoreGenerated }
    const note = parent.path === entry.path
      ? `already declared by ${parent.origin}`
      : `covered by ${parent.path}`
    const noteKey = parent.path === entry.path
      ? 'settings.backup.noteAlreadyDeclared'
      : 'settings.backup.noteCovered'
    const noteParams: Record<string, string> = parent.path === entry.path
      ? { origin: parent.origin }
      : { path: parent.path }
    return { path: entry.path, origin: entry.origin, included: false, note, noteKey, noteParams, ignoreGenerated: entry.ignoreGenerated }
  })
}

/** One workspace's state, as the backup and restore sides both read it. */
export interface BackupWorkspaceSource {
  id: string
  label: string
  settingsPath: string
  serversPath: string
  secretsPath: string
  servers: ServerConfig[]
}

/** One workspace the registry names, whether or not this host has it. */
interface ArchivedWorkspace {
  id: string
  label: string
}

export interface BackupSources {
  globalSettingsPath: string
  globalSecretsPath: string
  tlsDir: string
  /**
   * The workspace registry: ids and labels in selector order.
   *
   * Carried so a restore onto a blank host can *create* the workspaces an archive names,
   * with their labels. It is never written back as a file — a restore must not drop a
   * workspace this host added since, so only the missing ones are created.
   */
  registryPath: string
  /** Extra paths in every backup, in addition to each server's own. */
  includePaths: string[]
  workspaces: BackupWorkspaceSource[]
  /**
   * The servers that are running right now, so a restore can say whose data it just replaced.
   *
   * A data path is copied over while its owner keeps running: the process holds open handles to
   * files that no longer exist under it, and whatever it wrote since the archive was taken is
   * gone. `origin` on a declared path is `<serverId>:<ENV>`, which is what names the owner.
   * Optional so a test or an embedded caller can leave it out.
   */
  runningServers?: () => Array<{ workspaceId: string, serverId: string }>
}

/** A workspace as the source builder needs it: identity, its file locations, its loaded servers. */
export interface BackupWorkspaceInput {
  id: string
  label: string
  settingsPath: string
  serversPath: string
  secretsPath: string
  servers: ServerConfig[]
}

/**
 * What a backup captures, from a workspace list and the panel-wide paths.
 *
 * The **one** implementation, called by the running panel and by the CLI when no panel is up. A
 * second copy is how an offline backup would quietly capture something different from an online one
 * — and the archive is the thing people restore from, so a silent difference is the worst kind.
 *
 * `runningServers` stays a callback rather than a list: the panel answers it from live supervisor
 * views, and an offline caller answers it from the nanny state on disk. It is optional because a
 * caller that cannot know leaves it out; the warning it feeds is then simply absent.
 */
export function buildBackupSources(input: {
  globalSettingsPath: string
  globalSecretsPath: string
  tlsDir: string
  registryPath: string
  includePaths: string[]
  workspaces: BackupWorkspaceInput[]
  runningServers?: () => Array<{ workspaceId: string, serverId: string }>
}): BackupSources {
  return {
    globalSettingsPath: input.globalSettingsPath,
    globalSecretsPath: input.globalSecretsPath,
    tlsDir: input.tlsDir,
    registryPath: input.registryPath,
    includePaths: [...input.includePaths],
    ...(input.runningServers === undefined ? {} : { runningServers: input.runningServers }),
    // Paths are **inputs**, not re-derived here: the panel answers with the paths its supervisor
    // actually reads, and a helper that assumes the default locations could archive a different file
    // than the one that is running. Passing them through is what makes this a mapper rather than a
    // second source of truth.
    workspaces: input.workspaces.map(workspace => ({
      id: workspace.id,
      label: workspace.label,
      settingsPath: workspace.settingsPath,
      serversPath: workspace.serversPath,
      secretsPath: workspace.secretsPath,
      servers: workspace.servers,
    })),
  }
}

export interface BackupManifest {
  version: 1
  createdAt: number
  hostname: string
  /**
   * The release that wrote the archive, and the config schema it understood.
   *
   * Both are optional so an archive written before this field existed still reads.
   * They are what lets a restore say which panel an archive came from instead of
   * inferring it from the `meta` stamp inside the configs it happens to carry.
   */
  writtenBy?: string
  schema?: number
  /** `origin` and `workspace` are what let a restore land under *this* machine's paths. */
  data: Array<{ slug: string, path: string, origin?: string, workspace?: string }>
  /** Entries whose `dump` hook ran, and whose dump is under `dumps/<workspace>/<server>/`. */
  dumps?: Array<{ workspaceId: string, serverId: string }>
}

export interface RestoreOptions {
  confirm: boolean
  /** Required for, and ignored by, archives that are not password-protected. */
  password?: string
  /** Item ids to restore; omitted means every restorable item. */
  include?: string[]
  /**
   * Item ids to leave out, applied after `include`.
   *
   * The common case is one entry, not many: `--all --exclude global:secrets` backs everything up
   * except the password and token hashes. Naming the one thing to drop beats naming everything else,
   * and it is the safe default to recommend — an archive carrying them hands whoever holds it the
   * old machine's credentials.
   */
  exclude?: string[]
}

export type { RestorePlan }

/** One place a restore may write a data path to, and what declared it. */
interface DataTarget {
  workspace: string
  path: string
  origin: string
}

/**
 * An archived config, lifted to the schema this release reads.
 *
 * An archive is a snapshot, so the release that wrote it is often **older** than the one restoring
 * it — the backup someone takes before an upgrade is the one they reach for afterwards. Its files
 * carry the schema they were written with, and the parsers refuse an older stamp by design, so a
 * plain readability gate discarded every config an older archive carried: measured on a real
 * 0.7.21 archive applied to a blank 0.10.0 home, it reported "restored 4 items" and every one of
 * them was a secrets leaf, while both workspaces and the global settings were dropped as "not
 * valid" — a half-restored setup that reads as a success.
 *
 * So run the same chain `migrate` runs, on the contents rather than on a file: an archive that
 * needs lifting is lifted, and one this release cannot lift is still refused. A newer archive is
 * never rewritten here — that direction is refused earlier, from the manifest's own schema.
 *
 * **Lifting needs an explicit older stamp.** A file carrying no `meta.schema` is not evidence of an
 * older release — it is a seed (written in the current shape) or a damaged file, and lifting an
 * unparseable one let `{"not": "a servers file"}` be stamped as a valid empty `servers.config.json`,
 * which would restore a workspace with every entry deleted. Only a numeric stamp this release can
 * lift qualifies; anything else is left to its own parser, which refuses it.
 *
 * `null` means "this release cannot read it", which stays distinguishable from "it was fine".
 */
function liftArchived(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw))
    return null
  const meta = isRecord(raw.meta) ? raw.meta as { schema?: unknown } : {}
  // No stamp, or one this release does not lift: hand it back untouched for the caller's parser.
  if (typeof meta.schema !== 'number')
    return raw
  const plan = planConfigMigrations(meta.schema)
  if (plan.tooNew || plan.reached !== plan.to)
    return null
  if (plan.steps.length === 0)
    return raw
  const lifted = applyConfigMigrations(raw, meta.schema).config
  // Stamped, so the file records the release that actually wrote this shape: leaving the archive's
  // `writtenBy` beside a schema it never wrote would be a false record on disk.
  return isRecord(lifted) ? stampConfig(lifted as { $schema?: string, meta?: unknown }) : null
}

/**
 * A restored settings file is accepted when this release can read it — through
 * the same tolerant parser the stores use, so an archive from a newer release
 * keeps only the keys this one understands instead of being refused outright.
 *
 * An older one is lifted first (`liftArchived`), and the **lifted** value is returned so the
 * caller writes a config this release can load rather than the stamp it could not.
 */
function readableGlobalSettings(text: string | null): Record<string, unknown> | null {
  if (text === null)
    return null
  try {
    const lifted = liftArchived(JSON.parse(text))
    return lifted !== null && parseGlobalSettings(lifted).config !== null ? lifted : null
  }
  catch {
    return null
  }
}

/**
 * The workspaces an archive's registry names.
 *
 * Tolerant on purpose: an archive written before the registry was captured has no such
 * file, and a damaged one must not fail a restore whose leaves are perfectly readable.
 * The registry only contributes labels, so anything unreadable is simply dropped.
 */
function readArchivedRegistry(file: string): ArchivedWorkspace[] {
  const text = readText(file)
  if (text === null)
    return []
  try {
    const parsed = workspacesFileSchema(JSON.parse(text))
    if (parsed instanceof type.errors)
      return []
    return parsed.workspaces
  }
  catch {
    return []
  }
}

/**
 * Where a workspace created by a restore keeps its three leaves.
 *
 * Derived from the service's own `dataRoot` (the `.hh` directory the panel passes) rather
 * than the module-level path helpers, so a restore writes under the state root of the panel
 * running it — not under whatever `HHOSTED_HOME` resolves to at import time.
 */
function workspacePathsFor(dataRoot: string, id: string): Pick<BackupWorkspaceSource, 'settingsPath' | 'serversPath' | 'secretsPath'> {
  const dir = path.join(dataRoot, id)
  return {
    settingsPath: path.join(dir, 'settings.json'),
    serversPath: path.join(dir, 'servers.config.json'),
    secretsPath: path.join(dir, '.secrets.json'),
  }
}

/**
 * The manifest is written by us, but an uploaded archive's copy is attacker
 * controlled: never join an unvalidated slug into a path.
 */
function safeSlug(slug: unknown): string | null {
  if (typeof slug !== 'string' || slug.length === 0 || slug.length > 80)
    return null
  if (!/^[\w.-]+$/.test(slug) || slug === '.' || slug === '..')
    return null
  return slug
}

/** A flag is valid for one exact file revision, not for the name alone. */
function cacheKey(file: { sizeBytes: number, createdAt: number }): string {
  return `${file.sizeBytes}:${file.createdAt}`
}

/** Stable, filesystem-safe name for a data path inside the archive. */
export function slugifyPath(target: string): string {
  const cleaned = target.replace(/[^A-Z0-9]+/gi, '-').replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned.slice(-80) : 'path'
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  }
  catch {
    return null
  }
}

/**
 * Archives of the control plane's own state plus whatever paths the configs
 * declare. Two rules keep restore safe: the archive layout is an allowlist, and
 * a data path is only written back when a *config* still declares it — a current
 * one, or a workspace's servers file the same restore is about to apply.
 *
 * A backup is always a zip; a password makes it a WinZip-AES one, so the same
 * file opens in any archive manager either way.
 */
export class BackupService {
  /**
   * Whether an archive is encrypted is only knowable by reading its central
   * directory, which is async while `list()` is not. The flags are cached here
   * and refreshed in the background, so a state frame stays cheap.
   */
  private readonly flags = new Map<string, { key: string, encrypted: boolean }>()
  private refreshing: Promise<void> | null = null
  /** One scheduled pass at a time: a slow archive must not stack up behind itself. */
  private running = false
  private disposed = false
  /**
   * When this instance last attempted an automatic pass, whatever it wrote.
   *
   * The archive's own mtime is the durable record across a restart, but it cannot bound a
   * failed pass: nothing is written, so every panel tick would retry — once a second, for as
   * long as the failure lasts. This is the in-memory backstop for that case.
   */
  private lastAttemptAt: number | null = null
  /** Why the most recent scheduled pass failed, cleared by the next that works. */
  private scheduleError: { message: string, at: number } | null = null

  constructor(
    private readonly options: {
      /** Relative `backups.dir` values resolve against it (the panel passes `$HHOSTED_HOME/.hh`). */
      dataRoot: string
      getConfig: () => BackupsConfig
      getSources: () => BackupSources
      /**
       * Creates a workspace the archive brought and this host lacks, registry entry and
       * runtime together. Without it a restore can only fill workspaces that already
       * exist, which is what made "one archive is a whole setup" false.
       */
      ensureWorkspace?: (input: { id: string, label: string }) => void
      /** Called after a restore wrote settings/server files; the panel re-reads everything. */
      onRestored?: () => void
      /** Records a dump this entry still has to load, so its next start runs the hook. */
      onLoadPending?: (workspaceId: string, serverId: string, dumpDir: string) => void
    },
  ) {}

  /** Reads every archive once, so the first `list()` is already accurate. */
  async warm(): Promise<void> {
    await this.refresh()
  }

  dispose(): void {
    this.disposed = true
  }

  get directory(): string {
    return this.resolveDir()
  }

  /**
   * The policy and the status: what the settings page shows, and what the state frame carries.
   *
   * Deliberately **not** the selection model. `entries()` reads every workspace's `.secrets.json` and
   * `list()` stats every archive on disk, so including them here made the frame's cost scale with
   * workspaces × archives on a path rebuilt ~13×/s. A dialog asks `selection()` instead.
   */
  view(): BackupsView {
    const config = this.options.getConfig()
    const sources = this.options.getSources()
    return {
      enabled: config.enabled,
      dir: this.directory,
      keep: config.keep,
      schedule: { ...config.schedule },
      lastAutomaticAt: this.lastAutomatic(),
      ...(this.scheduleError === null ? {} : { scheduleError: { ...this.scheduleError } }),
      includePaths: [...sources.includePaths],
    }
  }

  /**
   * The selection model: every entry a capture could include, and every archive already on disk.
   *
   * Served by `GET /api/backups` and fetched when a dialog opens, never on a per-frame path.
   */
  selection(): BackupSelection {
    return {
      dir: this.directory,
      entries: this.entries(this.options.getSources()),
      files: this.list(),
    }
  }

  list(): BackupFile[] {
    const files = this.scan()
    for (const file of files) {
      const cached = this.flags.get(file.name)
      if (cached === undefined || cached.key !== cacheKey(file))
        void this.scheduleRefresh()
    }

    return files.map((file) => {
      const cached = this.flags.get(file.name)
      return {
        ...file,
        encrypted: cached !== undefined && cached.key === cacheKey(file) ? cached.encrypted : false,
      }
    })
  }

  /** Validated absolute path for a download, or null when the name is not a backup. */
  resolve(name: string): string | null {
    if (!/^[A-Z0-9][\w.-]*$/i.test(name) || name.includes('..'))
      return null
    const file = path.join(this.resolveDir(), name)
    return fs.existsSync(file) ? file : null
  }

  /**
   * `password` encrypts the archive; it is never stored anywhere.
   *
   * `automatic` marks an archive the schedule wrote, which is what keeps the two retention
   * counts apart: an automatic pass must never prune the backup a person took by hand, and a
   * manual one must not silently eat the history the schedule is keeping.
   */
  async create(options: { password?: string, include?: string[], exclude?: string[], automatic?: boolean } = {}): Promise<{ ok: boolean, file?: BackupFile, error?: string }> {
    const config = this.options.getConfig()
    if (!config.enabled)
      return { ok: false, error: 'backups are disabled' }

    const password = options.password !== undefined && options.password.length > 0 ? options.password : null
    // Omitted means everything; an id that names nothing is ignored, as on the restore side.
    const selects = selectionOf(options)
    // The narrow-only `wanted` set is still needed for the secrets narrowing below, which asks which
    // *fields* were named rather than whether an id is in scope.
    const wanted = options.include === undefined ? null : new Set(options.include)
    const capturesGlobal = (id: string): boolean => selects(id)
    // A workspace id alone means every leaf of that workspace.
    const capturesWorkspace = (id: string, suffix: string): boolean => selects(`workspace:${id}:${suffix}`)
    /**
     * The secrets of one scope the request asked for; `null` means "every one of them".
     * `workspaceId` is how a bare `workspace:<id>` selection covers all of its leaves.
     */
    const selectedSecretFields = (entryId: string, path: string, scope: SecretScope, workspaceId?: string): string[] | null => {
      const present = presentSecretKeys(parseSecrets(readText(path) ?? ''))
      const parts = secretParts(scope, present)
      // Per-field, and `selects` is the wrong question here: `--include global:secrets:password` names
      // one field, so a whole-entry `selects(entryId)` would pull in every sibling. What decides a
      // field is its own ids — the group and each of its fields — minus any exclusion above them.
      const picked = parts.filter((part) => {
        if (selects.isExcluded(entryId) || selects.isExcluded(`${entryId}:${part.key}`))
          return false
        const wantedField = wanted === null
          || wanted.has(entryId)
          || (workspaceId !== undefined && wanted.has(`workspace:${workspaceId}`))
          || wanted.has(`${entryId}:${part.key}`)
          || part.fields.some(field => wanted.has(`${entryId}:${field}`))
        return wantedField
      })
      return picked.length === parts.length ? null : picked.flatMap(part => part.fields)
    }

    const dir = this.resolveDir()
    const sources = this.options.getSources()
    const staging = path.join(dir, `.staging-${Date.now()}`)
    const createdAt = Date.now()
    // Milliseconds matter: two backups in the same second must not collide.
    const prefix = options.automatic === true ? AUTO_PREFIX : 'backup'
    const name = `${prefix}-${new Date(createdAt).toISOString().replace(/[:T]/g, '-').replace(/\.\d+Z$/, '')}-${createdAt % 1000}${SUFFIX}`
    const destination = path.join(dir, name)

    try {
      fs.mkdirSync(staging, { recursive: true })
      let captured = 0
      const copy = (relative: string, source: string, ignoreGenerated = false): void => {
        if (this.copyInto(staging, relative, source, ignoreGenerated))
          captured++
      }
      /**
       * Captures one secrets file, narrowed to the picked secrets. Copying the whole file
       * would capture the ones that were *not* picked, so a per-secret selection writes a
       * staged document holding only those — and the restore side merges by field, which
       * is what keeps a restore from wiping a secret the archive never carried.
       */
      const copySecrets = (relative: string, source: string, entryId: string, scope: SecretScope, workspaceId?: string): void => {
        const text = readText(source)
        if (text === null)
          return
        const fields = selectedSecretFields(entryId, source, scope, workspaceId)
        if (fields === null) {
          copy(relative, source)
          return
        }
        const chosen = pickSecrets(parseSecrets(text), fields)
        if (chosen === null)
          return
        const target = path.join(staging, relative)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, `${chosen}\n`)
        captured++
      }

      /**
       * True when the request touches a secrets entry at all: the entry itself, one of its
       * leaves, or — for a workspace — the workspace id, which names every leaf it has.
       */
      // Through `selects`, like every other capture: a third copy of "is this selected" is how
      // `--exclude` came to leave the secrets in the archive it was asked to leave them out of.
      // Upwards as well as down: `--include global:secrets:password` names a leaf, and the file that
      // holds it still has to be captured — the narrowing above then keeps the sibling out.
      const touchesSecrets = (entryId: string, workspaceId?: string): boolean =>
        selects(entryId)
        || (wanted !== null && [...wanted].some(id => id.startsWith(`${entryId}:`)))
        || (workspaceId !== undefined && selects(`workspace:${workspaceId}:secrets`))

      if (capturesGlobal('global:settings'))
        copy('global/settings.json', sources.globalSettingsPath)
      if (touchesSecrets('global:secrets'))
        copySecrets('global/secrets.json', sources.globalSecretsPath, 'global:secrets', 'global')
      if (capturesGlobal('global:tls'))
        copy('global/tls', sources.tlsDir)
      // Always, and unconditionally: the registry is what lets a restore onto a blank host
      // know a workspace exists at all, and it is a few bytes of ids and labels. Tying it
      // to a selection would make "restore this workspace" impossible on a host that has
      // never heard of it. Not counted as a capture — a selection that names nothing real
      // is still "nothing was selected", which the check below refuses.
      this.copyInto(staging, `global/${REGISTRY}`, sources.registryPath)

      /**
       * The dump phase: give every entry with a `dump` hook the chance to produce a consistent copy.
       *
       * Before anything is copied, because the dump is the authoritative artifact — the raw data
       * directory beside it is a convenience, and a dump that failed must not leave an archive that
       * looks complete. The output lands in `dumps/<workspace>/<server>/`, which the restore side
       * fills again at the same path, so `{dumpDir}` means the same thing in both directions.
       */
      const dumped: Array<{ workspaceId: string, serverId: string }> = []
      for (const workspace of sources.workspaces) {
        for (const server of workspace.servers) {
          const hook = server.dump
          if (hook === undefined || hook === null)
            continue
          // The dump belongs to the entry, so the selection that names the entry includes it and an
          // exclusion that names the entry — or its dump — leaves it out. This was the last copy of
          // the selection rule that did not consult `exclude`, so `--exclude workspace:default` still
          // *ran* that workspace's dump program and archived the result.
          if (!selects(`workspace:${workspace.id}:dump:${server.id}`)) {
            continue
          }
          const relative = path.join('dumps', workspace.id, server.id)
          const dumpDir = path.join(staging, relative)
          const result = await runBackupHook(hook, server, dumpDir)
          if (!result.ok) {
            fs.rmSync(staging, { recursive: true, force: true })
            return { ok: false, error: hookFailure('dump', server, result) }
          }
          dumped.push({ workspaceId: workspace.id, serverId: server.id })
        }
      }

      const data: BackupManifest['data'] = []
      for (const workspace of sources.workspaces) {
        const root = `workspaces/${workspace.id}`
        if (capturesWorkspace(workspace.id, 'settings'))
          copy(`${root}/settings.json`, workspace.settingsPath)
        if (capturesWorkspace(workspace.id, 'servers'))
          copy(`${root}/servers.config.json`, workspace.serversPath)
        if (touchesSecrets(`workspace:${workspace.id}:secrets`, workspace.id))
          copySecrets(`${root}/secrets.json`, workspace.secretsPath, `workspace:${workspace.id}:secrets`, 'workspace', workspace.id)

        for (const declared of this.declaredData(workspace.servers, sources.includePaths)) {
          if (!declared.included)
            continue
          if (!capturesWorkspace(workspace.id, `data:${declared.path}`))
            continue
          if (!fs.existsSync(declared.path))
            continue
          const slug = slugifyPath(declared.path)
          if (data.some(entry => entry.slug === slug))
            continue
          if (!this.copyInto(staging, path.join('data', slug), declared.path, declared.ignoreGenerated))
            continue
          captured++
          data.push({ slug, path: declared.path, origin: declared.origin, workspace: workspace.id })
        }
      }

      // A selection that captured nothing would only produce a manifest — and an exclusion is a
      // selection too: `--all --exclude <everything>` wrote a 631-byte archive holding nothing but
      // the registry, which reads as a backup and restores nothing.
      if ((wanted !== null || (options.exclude?.length ?? 0) > 0) && captured === 0) {
        fs.rmSync(staging, { recursive: true, force: true })
        return { ok: false, error: 'nothing was selected to back up' }
      }

      const manifest: BackupManifest = {
        version: 1,
        createdAt,
        hostname: os.hostname(),
        writtenBy: appVersion(),
        schema: CONFIG_SCHEMA,
        data,
        // Which entries brought a dump, so a restore can tell "this archive has no dump for it" from
        // "this archive was taken before the hook existed".
        ...(dumped.length === 0 ? {} : { dumps: dumped }),
      }
      fs.writeFileSync(path.join(staging, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)

      await createZip(staging, destination, password === null ? {} : { password })

      fs.rmSync(staging, { recursive: true, force: true })
      this.prune()

      const stats = fs.statSync(destination)
      this.flags.set(name, { key: `${stats.size}:${Math.round(stats.mtimeMs)}`, encrypted: password !== null })
      return { ok: true, file: { name, sizeBytes: stats.size, createdAt, encrypted: password !== null } }
    }
    catch (error) {
      fs.rmSync(staging, { recursive: true, force: true })
      fs.rmSync(destination, { force: true })
      return { ok: false, error: errorMessage(error) }
    }
  }

  remove(name: string): boolean {
    const file = this.resolve(name)
    if (file === null)
      return false
    fs.rmSync(file, { force: true })
    this.flags.delete(name)
    return true
  }

  /**
   * Validates an archive, then (unless `confirm` is false) applies whichever of
   * its items were selected. Data paths come from the *current* sources, or from
   * a workspace's servers file that is itself being restored — never from the
   * archive's manifest alone.
   */
  async restore(archivePath: string, options: RestoreOptions): Promise<RestorePlan> {
    // An **apply** takes the lock here, so every caller has it: the panel's route, its local control
    // channel, and the CLI working with no panel at all. A dry run writes nothing and needs none.
    // Holding it any higher up was three separate guards, and one of them was always going to be
    // forgotten — which is exactly what happened to the panel's own route.
    const lock = options.confirm ? acquireRestoreLock(this.options.dataRoot) : null
    if (lock !== null && 'heldBy' in lock) {
      throw new DetailedError(
        `another restore is running (pid ${lock.heldBy.pid}, since ${new Date(lock.heldBy.startedAt).toISOString()}) — wait for it, or remove ${path.join(this.options.dataRoot, 'restore.lock')} if it is stale`,
        { statusCode: 409, code: 'RESTORE_IN_PROGRESS' },
      )
    }
    try {
      return await this.applyRestore(archivePath, options)
    }
    finally {
      if (lock !== null && !('heldBy' in lock))
        lock.release()
    }
  }

  private async applyRestore(archivePath: string, options: RestoreOptions): Promise<RestorePlan> {
    const password = options.password !== undefined && options.password.length > 0 ? options.password : null
    // The two structured lists are optional on the wire (a new UI reads an older panel), but this
    // side always fills them, so it builds them as required.
    const plan: RestorePlan & { appliedIds: string[], skippedItems: RestoreSkip[], createdWorkspaces: string[], replacedUnderRunning: NonNullable<RestorePlan['replacedUnderRunning']> } = {
      dryRun: !options.confirm,
      encrypted: false,
      needsPassword: false,
      items: [],
      applied: [],
      appliedIds: [],
      skipped: [],
      skippedItems: [],
      restartRequired: false,
      reloaded: false,
      createdWorkspaces: [],
      replacedUnderRunning: [],
    }

    const admitted = await admitArchive(archivePath)
    if (!admitted.ok)
      return { ...plan, error: admitted.error }
    const entries = admitted.entries

    const staging = path.join(this.resolveDir(), `.restore-${Date.now()}`)

    try {
      plan.encrypted = entries.some(entry => entry.encrypted)
      if (plan.encrypted && password === null)
        return { ...plan, needsPassword: true, error: 'this backup is password-protected' }

      fs.mkdirSync(staging, { recursive: true })
      const extracted = await extractZip(archivePath, staging, {
        names: entries.map(entry => entry.name),
        ...(password === null ? {} : { password }),
      })
      for (const name of extracted.skipped) {
        plan.skipped.push(`${name} (symbolic link, skipped)`)
        plan.skippedItems.push({ label: name, reasonKey: 'settings.restore.reasonSymbolicLink' })
      }

      const manifestPath = path.join(staging, MANIFEST)
      if (!fs.existsSync(manifestPath))
        return { ...plan, error: 'the archive has no manifest' }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest

      // An archive naming a schema this release cannot read is refused outright: the
      // per-file readability gates below would each skip their own piece and report a
      // half-restored setup, which reads as a partial success rather than the refusal
      // it is. Optional, so an archive written before this stamp still restores.
      plan.archive = manifestInfo(manifest)
      if (manifest.schema !== undefined && manifest.schema > CONFIG_SCHEMA) {
        return {
          ...plan,
          error: `written by home-hosted ${manifest.writtenBy ?? 'a newer release'} (config schema ${manifest.schema}); this release understands schema ${CONFIG_SCHEMA}`,
        }
      }

      const sources = this.options.getSources()
      const selects = selectionOf(options)
      const actions = new Map<string, () => void>()

      const addItem = (item: Omit<RestoreItem, 'selected'>, apply: (() => void) | null, aliases: string[] = []): void => {
        if (apply === null) {
          plan.items.push({ ...item, selected: false })
          plan.skipped.push(`${item.label}${item.note === null ? '' : ` (${item.note})`}`)
          plan.skippedItems.push({
            label: item.label,
            ...(item.labelKey === undefined ? {} : { labelKey: item.labelKey }),
            ...(item.labelParams === undefined ? {} : { labelParams: item.labelParams }),
            // The note is already the reason when there is one; otherwise the row is simply not
            // something this instance can write back.
            reasonKey: item.noteKey ?? 'settings.restore.reasonUnrestorable',
            ...(item.noteParams === undefined ? {} : { reasonParams: item.noteParams }),
          })
          return
        }
        // An alias is a coarse id (`workspace:<id>` for every leaf), so any of them selecting the
        // item counts too.
        // An exclusion beats an alias: `--exclude global:secrets` must not be undone by the item's
        // own short alias (`secrets`) selecting it back in.
        // An alias works for both directions, because the item already carries them and the person
        // who typed `--exclude config` meant this row.
        const excluded = selects.isExcluded(item.id) || aliases.some(alias => selects.isExcluded(alias))
        const selected = !excluded && (selects(item.id) || aliases.some(alias => selects(alias)))
        plan.items.push({ ...item, selected })
        if (selected) {
          actions.set(item.id, apply)
        }
        else {
          plan.skipped.push(`${item.label} (not selected)`)
          plan.skippedItems.push({
            label: item.label,
            ...(item.labelKey === undefined ? {} : { labelKey: item.labelKey }),
            ...(item.labelParams === undefined ? {} : { labelParams: item.labelParams }),
            reasonKey: 'settings.restore.reasonNotSelected',
          })
        }
      }

      // ---------------------------------------------------------------- global
      const settingsText = readText(path.join(staging, 'global', 'settings.json'))
      const liftedGlobal = readableGlobalSettings(settingsText)
      const parsedGlobal = liftedGlobal === null ? null : parseGlobalSettings(liftedGlobal).config
      if (settingsText !== null && parsedGlobal === null) {
        plan.skipped.push('Global settings (the archive\'s settings are not valid)')
        plan.skippedItems.push({ label: 'Global settings', labelKey: 'settings.backup.entryGlobalSettings', reasonKey: 'settings.restore.reasonInvalidSettings' })
      }
      if (parsedGlobal !== null && liftedGlobal !== null) {
        // The **lifted** config is what gets written: the archive's file carries the schema it was
        // written with, and writing it back verbatim restores a file this release then refuses.
        const globalText = `${JSON.stringify(liftedGlobal, null, 2)}\n`
        addItem({ id: 'global:settings', label: 'Global settings', labelKey: 'settings.backup.entryGlobalSettings', kind: 'settings', restorable: true, note: null }, () => {
          writeFileAtomic(sources.globalSettingsPath, globalText)
        }, ['config'])
      }

      const globalSecrets = readText(path.join(staging, 'global', 'secrets.json'))
      if (globalSecrets !== null) {
        // The whole-entry item writes the file outright, which is only right when nothing inside it
        // was excluded. With a leaf excluded (`--exclude global:secrets:password`) it merges instead,
        // so the excluded field keeps the value this host already had rather than being replaced by
        // the archive's — the per-field items below exist to be the precise form, and this one must
        // not undo them.
        const globalSecretKeys = presentSecretKeys(parseSecrets(globalSecrets))
        const everyGlobalSecretWanted = secretParts('global', globalSecretKeys)
          .every(part => !selects.isExcluded(`global:secrets:${part.key}`)
            && !part.fields.some(field => selects.isExcluded(`global:secrets:${field}`)))
        addItem(
          { id: 'global:secrets', label: 'Global secrets (password, API token)', labelKey: 'settings.backup.entryGlobalSecrets', kind: 'secrets', restorable: true, note: null },
          everyGlobalSecretWanted
            ? () => writeFileAtomic(sources.globalSecretsPath, globalSecrets, { mode: 0o600 })
            : () => {
                // Only the fields this host may take: the exclusion decides, not the item.
                const take = secretParts('global', globalSecretKeys)
                  .filter(part => !selects.isExcluded(`global:secrets:${part.key}`)
                    && !part.fields.some(field => selects.isExcluded(`global:secrets:${field}`)))
                  .flatMap(part => part.fields)
                mergeIntoFile(sources.globalSecretsPath, globalSecrets, take)
              },
          ['secrets'],
        )
        // One item per secret the archive carries, so the password can come back without
        // the API token. Applying one merges by field: writing the whole archived file
        // would reinstate every secret in it, which is exactly what the person unpicked.
        for (const part of secretParts('global', presentSecretKeys(parseSecrets(globalSecrets)))) {
          addItem({
            id: `global:secrets:${part.key}`,
            label: `Global secrets: ${SECRET_LABELS[part.key]?.en ?? part.key}`,
            labelKey: 'settings.backup.restoreItemLabel',
            labelParams: { workspace: 'global', item: part.key },
            kind: 'secrets',
            restorable: true,
            note: null,
          }, () => {
            mergeIntoFile(sources.globalSecretsPath, globalSecrets, part.fields)
          })
        }
      }

      const tlsInArchive = path.join(staging, 'global', 'tls')
      if (fs.existsSync(tlsInArchive)) {
        const files = fs.readdirSync(tlsInArchive).filter(file => fs.statSync(path.join(tlsInArchive, file)).isFile())
        addItem({ id: 'global:tls', label: 'TLS certificate', labelKey: 'settings.backup.entryTlsCertificate', kind: 'tls', restorable: true, note: null }, () => {
          fs.mkdirSync(sources.tlsDir, { recursive: true })
          for (const file of files) {
            const mode = file.endsWith('.key.pem') ? { mode: 0o600 } : {}
            writeFileAtomic(path.join(sources.tlsDir, file), fs.readFileSync(path.join(tlsInArchive, file), 'utf8'), mode)
          }
        }, ['tls'])
      }

      // ------------------------------------------------------- workspace registry
      /**
       * The workspaces the archive names, from its registry file.
       *
       * Optional: an archive written before the registry was captured carries none, and
       * then every archived workspace is still restorable under its own id — the label is
       * the only thing the registry adds.
       */
      const archivedWorkspaces = new Map<string, ArchivedWorkspace>()
      for (const entry of readArchivedRegistry(path.join(staging, 'global', REGISTRY))) {
        archivedWorkspaces.set(entry.id, entry)
      }

      // ------------------------------------------------------------ workspaces
      /** Every archived servers file this release can read, selected or not. */
      const archivedServers = new Map<string, ServerConfig[]>()
      /**
       * Workspaces the archive names that this host does not have, with the paths a
       * restore will create them under. The directories are made only when one of
       * their leaves is actually applied, so a dry run writes nothing.
       */
      const createdWorkspaces = new Map<string, BackupWorkspaceSource>()

      const archiveWorkspaces = path.join(staging, 'workspaces')
      if (fs.existsSync(archiveWorkspaces)) {
        for (const entry of fs.readdirSync(archiveWorkspaces, { withFileTypes: true })) {
          if (!entry.isDirectory())
            continue
          const id = entry.name
          const dir = path.join(archiveWorkspaces, id)
          const settings = readText(path.join(dir, 'settings.json'))
          const servers = readText(path.join(dir, 'servers.config.json'))
          const secrets = readText(path.join(dir, 'secrets.json'))
          // A label the archive's registry carried, else the id: the registry is the
          // only place a label lives, so an archive without it still restores under a
          // name the person can find afterwards.
          const archivedLabel = archivedWorkspaces.get(id)?.label ?? id

          // A workspace this host does not have is created, not skipped: an archive is the whole
          // setup. Skipping it also let the data pass match by origin alone, writing one
          // workspace's database into another's declared directory.
          const workspace = sources.workspaces.find(candidate => candidate.id === id)
            ?? createdWorkspaces.get(id)
            ?? (workspaceIdSchema(id) instanceof type.errors
              ? undefined
              : { id, label: archivedLabel, ...workspacePathsFor(this.options.dataRoot, id), servers: [] as ServerConfig[] })
          if (workspace === undefined) {
            plan.skipped.push(`${id} (not a usable workspace id)`)
            plan.skippedItems.push({ label: id, reasonKey: 'settings.restore.reasonInvalidWorkspace' })
            continue
          }
          if (!sources.workspaces.some(candidate => candidate.id === id))
            createdWorkspaces.set(id, workspace)

          if (settings !== null) {
            const liftedSettings = readableWorkspaceSettings(settings)
            if (liftedSettings !== null) {
              const settingsText = `${JSON.stringify(liftedSettings, null, 2)}\n`
              addItem({ id: `workspace:${id}:settings`, label: `${workspace.label}: Settings`, labelKey: 'settings.backup.restoreItemLabel', labelParams: { workspace: workspace.label, item: 'settings' }, kind: 'settings', workspaceId: id, restorable: true, note: null }, () => {
                fs.mkdirSync(path.dirname(workspace.settingsPath), { recursive: true })
                writeFileAtomic(workspace.settingsPath, settingsText)
              })
            }
            else {
              plan.skipped.push(`${workspace.label}: Settings (the archive's settings are not valid)`)
              plan.skippedItems.push({ label: `${workspace.label}: Settings`, labelKey: 'settings.backup.restoreItemLabel', labelParams: { workspace: workspace.label, item: 'settings' }, reasonKey: 'settings.restore.reasonInvalidSettings' })
            }
          }

          if (servers !== null) {
            const parsed = readableServersFile(servers)
            const liftedServers = parsed === null ? null : liftArchived(JSON.parse(servers))
            if (parsed !== null && liftedServers !== null) {
              const serversText = `${JSON.stringify(liftedServers, null, 2)}\n`
              archivedServers.set(id, parsed)
              addItem({ id: `workspace:${id}:servers`, label: `${workspace.label}: Servers`, labelKey: 'settings.backup.restoreItemLabel', labelParams: { workspace: workspace.label, item: 'servers' }, kind: 'servers', workspaceId: id, restorable: true, note: null }, () => {
                fs.mkdirSync(path.dirname(workspace.serversPath), { recursive: true })
                writeFileAtomic(workspace.serversPath, serversText)
              })
            }
            else {
              plan.skipped.push(`${workspace.label}: Servers (the archive's servers are not valid)`)
              plan.skippedItems.push({ label: `${workspace.label}: Servers`, labelKey: 'settings.backup.restoreItemLabel', labelParams: { workspace: workspace.label, item: 'servers' }, reasonKey: 'settings.restore.reasonInvalidServers' })
            }
          }

          if (secrets !== null) {
            addItem({ id: `workspace:${id}:secrets`, label: `${workspace.label}: Secrets`, labelKey: 'settings.backup.restoreItemLabel', labelParams: { workspace: workspace.label, item: 'secrets' }, kind: 'secrets', workspaceId: id, restorable: true, note: null }, () => {
              fs.mkdirSync(path.dirname(workspace.secretsPath), { recursive: true })
              writeFileAtomic(workspace.secretsPath, secrets, { mode: 0o600 })
            })
            for (const part of secretParts('workspace', presentSecretKeys(parseSecrets(secrets)))) {
              addItem({
                id: `workspace:${id}:secrets:${part.key}`,
                label: `${workspace.label}: ${SECRET_LABELS[part.key]?.en ?? part.key}`,
                labelKey: 'settings.backup.restoreItemLabel',
                labelParams: { workspace: workspace.label, item: part.key },
                kind: 'secrets',
                workspaceId: id,
                restorable: true,
                note: null,
              }, () => {
                fs.mkdirSync(path.dirname(workspace.secretsPath), { recursive: true })
                mergeIntoFile(workspace.secretsPath, secrets, part.fields)
              })
            }
          }
        }
      }

      // ------------------------------------------------------------------ data
      // A data path is written to a path a *config* declares — this instance's,
      // or the servers file the archive brings and the restore is about to apply.
      const instanceTargets: DataTarget[] = []
      for (const workspace of sources.workspaces) {
        for (const declared of this.declaredData(workspace.servers, sources.includePaths)) {
          if (!declared.included)
            continue
          instanceTargets.push({ workspace: workspace.id, path: declared.path, origin: declared.origin })
        }
      }

      const archivedIncludePaths = actions.has('global:settings') && parsedGlobal !== null
        ? parsedGlobal.backups.includePaths
        : sources.includePaths
      const archiveAll: DataTarget[] = []
      const archiveTargets: DataTarget[] = []
      for (const [id, servers] of archivedServers) {
        for (const declared of this.declaredData(servers, archivedIncludePaths)) {
          if (!declared.included)
            continue
          const target = { workspace: id, path: declared.path, origin: declared.origin }
          archiveAll.push(target)
          // Only a servers file this restore is applying may name a destination.
          if (actions.has(`workspace:${id}:servers`))
            archiveTargets.push(target)
        }
      }

      // A `global` include path and a second `backupPaths` value share one origin, so an
      // origin match alone would write both to the first candidate. Pair same-origin
      // declarations by order instead — the archive wrote them in the same resolve order.
      const usedArchive = new Set<DataTarget>()
      const usedInstance = new Set<DataTarget>()
      const take = (list: DataTarget[], used: Set<DataTarget>, test: (target: DataTarget) => boolean): DataTarget | undefined => {
        const found = list.find(target => !used.has(target) && test(target))
        if (found === undefined)
          return undefined
        used.add(found)
        return found
      }
      /**
       * Where one archived data path lands, never across a workspace boundary.
       *
       * An archive that names a workspace is only ever matched against that workspace's
       * declarations: the un-scoped fallbacks below exist to survive a re-labelled or
       * re-ordered config, and letting them cross workspaces wrote one workspace's data
       * over a path another one had declared. A path only one workspace declares has no
       * candidate at all in the other, so the entry is reported instead of guessed at.
       */
      const matchTarget = (origin: string | undefined, workspace: string | undefined, archivedPath: string): DataTarget | undefined => {
        const inScope = (target: DataTarget): boolean => workspace === undefined || target.workspace === workspace
        const archive = archiveTargets.filter(inScope)
        const instance = instanceTargets.filter(inScope)
        if (origin !== undefined) {
          return take(archive, usedArchive, target => target.origin === origin)
            ?? take(instance, usedInstance, target => target.origin === origin)
            ?? take(archive, usedArchive, target => target.path === archivedPath)
            ?? take(instance, usedInstance, target => target.path === archivedPath)
        }
        return take(archive, usedArchive, target => target.path === archivedPath)
          ?? take(instance, usedInstance, target => target.path === archivedPath)
      }

      /**
       * `workspace:serverId` for every entry running at this moment.
       *
       * Built once, before anything is copied: a data path whose owner is running is about to be
       * replaced under a live process, and the plan has to name it. Read here rather than in the
       * apply closure so a dry run reports the same list the apply would.
       */
      const runningOwners = new Set(
        (sources.runningServers?.() ?? []).map(entry => `${entry.workspaceId}:${entry.serverId}`),
      )

      // A dump is a restorable item in its own right: it is the thing the engine reads, and leaving
      // it out of the plan meant `--all` reported nothing to restore and the load hook never ran.
      for (const dump of manifest.dumps ?? []) {
        const from = path.join(staging, 'dumps', dump.workspaceId, dump.serverId)
        if (!fs.existsSync(from))
          continue
        const id = `workspace:${dump.workspaceId}:dump:${dump.serverId}`
        addItem({
          id,
          label: `dump:${dump.serverId}`,
          kind: 'data',
          restorable: true,
          workspaceId: dump.workspaceId,
          note: null,
        }, () => {
          // Nothing is written over this host's files: the dump is replayed by the entry's `load`
          // hook, which runs after everything landed. The item exists so the selection can name it.
        })
      }

      const archivedEntries = Array.isArray(manifest.data) ? manifest.data.filter(isRecord) : []
      for (const entry of archivedEntries) {
        const archivedPath = typeof entry.path === 'string' ? entry.path : ''
        const origin = typeof entry.origin === 'string' ? entry.origin : undefined
        const workspace = typeof entry.workspace === 'string' ? entry.workspace : undefined
        const from = path.join(staging, 'data', safeSlug(entry.slug) ?? slugifyPath(archivedPath))
        const target = matchTarget(origin, workspace, archivedPath)
        const targetWorkspace = target?.workspace ?? workspace
        const base: Omit<RestoreItem, 'selected'> = {
          id: target === undefined ? `data:${archivedPath}` : `workspace:${target.workspace}:data:${target.path}`,
          label: target?.path ?? archivedPath,
          kind: 'data',
          restorable: false,
          note: null,
          ...(targetWorkspace === undefined ? {} : { workspaceId: targetWorkspace }),
        }
        const aliases = [`data:${archivedPath}`]

        if (target === undefined) {
          const declaredByBackup = archiveAll.some(candidate => candidate.origin === origin && (workspace === undefined || candidate.workspace === workspace))
          addItem({
            ...base,
            note: declaredByBackup
              ? 'declared by the backup\'s config, which is not being restored'
              : 'not declared by this config, nor by the backup',
            noteKey: declaredByBackup
              ? 'settings.backup.noteDeclaredByBackup'
              : 'settings.backup.noteNotDeclared',
          }, null, aliases)
          continue
        }
        if (!fs.existsSync(from)) {
          addItem({ ...base, note: 'missing from the archive', noteKey: 'settings.backup.noteMissingFromArchive' }, null, aliases)
          continue
        }

        // The entry that declares this path, so a restore can name it if it is running.
        // Recorded at *plan* time, not inside the apply closure: a dry run has to report the
        // same list, otherwise the person cannot see what to stop before applying.
        const ownerId = target.origin.split(':')[0] ?? ''
        const covered = !selects.isExcluded(base.id) && (selects(base.id) || aliases.some(alias => selects(alias)))
        if (covered && runningOwners.has(`${target.workspace}:${ownerId}`))
          plan.replacedUnderRunning.push({ workspaceId: target.workspace, serverId: ownerId, path: target.path })

        addItem(
          { ...base, restorable: true, ...(target.path === archivedPath ? { note: null } : { note: `restored from ${archivedPath}`, noteKey: 'settings.backup.noteRestoredFrom', noteParams: { path: archivedPath } }) },
          // `cpSync` follows symlinks already in the destination tree, so a link
          // standing inside the declared path would carry the archive's files out of
          // it. The destination of each entry is what is checked, because that is
          // where the link is resolved; the links themselves are never recreated,
          // which is the stated invariant.
          () => {
            fs.cpSync(from, target.path, {
              recursive: true,
              force: true,
              filter: (_source, destination) => isInsideResolved(target.path, destination),
            })
          },
          aliases,
        )
      }

      // The plan has to say whether a restart is needed even in a dry run: only
      // the panel's own listener does, its servers are re-read from the file.
      if (parsedGlobal !== null && actions.has('global:settings') && settingsText !== null) {
        const currentText = readText(sources.globalSettingsPath)
        const current = readableGlobalSettings(currentText)
        plan.restartRequired = JSON.stringify(parsedGlobal.control) !== JSON.stringify(current === null ? null : (parseGlobalSettings(current).config?.control ?? null))
      }

      if (!options.confirm) {
        // A dry run reports what *would* happen, so the UI can show the plan
        // and the selection before anything is written.
        plan.applied = [...actions.keys()].map(id => labelOf(plan, id))
        plan.appliedIds = [...actions.keys()]
        return plan
      }

      for (const [id, apply] of actions) {
        apply()
        plan.applied.push(labelOf(plan, id))
      }
      plan.appliedIds = [...actions.keys()]

      // The registry entries come last, and only once their leaves landed: a workspace
      // the panel knows about but whose files were never written would be a workspace
      // that exists and is empty, which is worse than one that is plainly absent.
      for (const workspace of createdWorkspaces.values()) {
        if (![...actions.keys()].some(id => id.startsWith(`workspace:${workspace.id}:`)))
          continue
        this.options.ensureWorkspace?.({ id: workspace.id, label: workspace.label })
        plan.createdWorkspaces.push(workspace.id)
      }

      /**
       * The load phase: let each restored entry put its own dump back.
       *
       * After the files landed and before the panel reloads, so the engine reads a config this
       * release has just written rather than the one it replaced. Only the entries the archive
       * actually brought a dump for — an archive taken before the hook existed has none, and running
       * `mongorestore` on a directory that is not there fails the whole restore for no reason.
       */
      // Only dumps the selection actually applied: deselecting `workspace:<id>:dump:<server>` must not
      // load it, exactly as for any other item.
      // `actions` is filled while the plan is built, which happens after this line — so the
      // selection is checked inside the loop below, not here.
      const archivedDumps = manifest.dumps ?? []
      // Recorded after `onRestored`: on a blank host the workspace and its entry are created by this
      // restore, so there is no supervisor to hold the pending load until that reload has run.
      const pendingLoads: Array<{ workspaceId: string, serverId: string, staged: string }> = []
      for (const entry of archivedDumps) {
        if (!plan.appliedIds.some(id => id.startsWith(`workspace:${entry.workspaceId}:`)))
          continue
        // Deselecting `workspace:<id>:dump:<server>` must not load it, exactly as for any other item.
        if (!actions.has(`workspace:${entry.workspaceId}:dump:${entry.serverId}`)
          && !actions.has(`workspace:${entry.workspaceId}`)) {
          continue
        }
        // The **archive's** config, not the live one: `sources` was read before the restore wrote
        // anything, so it still describes the host as it was. The hooks being restored are the
        // archive's, which is the whole point of a migration onto a blank machine.
        const archivedServers = readArchivedServers(staging, entry.workspaceId)
        const server = archivedServers.find(candidate => candidate.id === entry.serverId)
        // The entry survives the restore (its config came from the archive) but may have no `load`
        // hook: the dump is still restored as a file, and saying so is better than silence.
        if (server?.load === undefined || server.load === null) {
          plan.skipped.push(`the dump for "${entry.serverId}" was restored but this entry has no load hook`)
          continue
        }
        const dumpDir = path.join(staging, 'dumps', entry.workspaceId, entry.serverId)
        if (!fs.existsSync(dumpDir)) {
          plan.skipped.push(`the dump for "${entry.serverId}" is missing from the archive`)
          continue
        }
        // Staged, not run. A load hook talks to a server that is answering — `mongorestore`,
        // `pg_restore`, `redis-cli` all connect — and this entry is stopped at this point. The dump
        // is copied where the entry can reach it after a restart, and its next `start` runs the hook
        // once the port accepts a connection.
        const staged = path.join(this.options.dataRoot, PENDING_LOAD, entry.workspaceId, entry.serverId)
        fs.mkdirSync(path.dirname(staged), { recursive: true })
        fs.cpSync(dumpDir, staged, { recursive: true, force: true })
        pendingLoads.push({ workspaceId: entry.workspaceId, serverId: entry.serverId, staged })
        plan.hooks = [...(plan.hooks ?? []), {
          serverId: entry.serverId,
          workspaceId: entry.workspaceId,
          action: 'load',
          ok: true,
          output: 'staged — runs when this entry next starts',
        }]
      }

      // Staged **before** the reload. `onRestored` re-reads the config and starts autostart entries,
      // and `createEntry` reads `pendingLoad` from disk at that moment — so recording it afterwards
      // missed both triggers: the entry was already running, and its state had been read already.
      for (const load of pendingLoads)
        this.options.onLoadPending?.(load.workspaceId, load.serverId, load.staged)

      if (this.options.onRestored !== undefined && [...actions.keys()].some(id => RELOADABLE.test(id))) {
        plan.reloaded = true
        // The panel re-reads the restored settings and servers here, so what the
        // archive brought exists immediately instead of after a restart.
        this.options.onRestored()
      }

      return plan
    }
    catch (error) {
      // Extraction happens before anything is written, so a rejected password has
      // changed nothing at all.
      if (isInvalidPassword(error))
        return { ...plan, encrypted: true, needsPassword: true, error: 'the password is wrong' }
      // A restore is not transactional: say what already landed, so a failure
      // cannot look like nothing happened.
      const done = plan.applied.length > 0 ? ` — already applied: ${plan.applied.join(', ')}` : ''
      return { ...plan, error: `${errorMessage(error)}${done}` }
    }
    finally {
      fs.rmSync(staging, { recursive: true, force: true })
    }
  }

  /** Selectable entries: the three global slices, then one per workspace. */
  private entries(sources: BackupSources): BackupEntry[] {
    const missing = (path: string, key: string): Pick<BackupEntry, 'note' | 'noteKey'> => {
      const absent = this.missingNote(path)
      return absent === null ? { note: null } : { note: absent, noteKey: key }
    }
    const entries: BackupEntry[] = [
      { id: 'global:settings', label: 'Global settings', labelKey: 'settings.backup.entryGlobalSettings', kind: 'settings', ...missing(sources.globalSettingsPath, 'settings.backup.noteMissing'), items: [] },
      { id: 'global:secrets', label: 'Global secrets (password, API token)', labelKey: 'settings.backup.entryGlobalSecrets', kind: 'secrets', ...missing(sources.globalSecretsPath, 'settings.backup.noteMissing'), items: this.secretItems('global', 'global:secrets', sources.globalSecretsPath) },
      { id: 'global:tls', label: 'TLS certificate', labelKey: 'settings.backup.entryTlsCertificate', kind: 'tls', ...missing(sources.tlsDir, 'settings.backup.noteMissing'), items: [] },
    ]

    for (const workspace of sources.workspaces) {
      entries.push({
        id: `workspace:${workspace.id}`,
        label: workspace.label,
        kind: 'workspace',
        workspaceId: workspace.id,
        note: null,
        items: this.workspaceItems(workspace, sources.includePaths),
      })
    }

    return entries
  }

  /**
   * One leaf per secret the file actually holds, so a restore can bring back the
   * password without the API token, or the Telegram token without the DDNS credentials.
   *
   * The set comes from the file's own top-level keys rather than a list here, so a
   * secret added later appears on its own — the failure mode of a second list is a
   * secret that can be captured but never restored individually.
   */
  private secretItems(scope: SecretScope, entryId: string, path: string): BackupEntry['items'] {
    const present = presentSecretKeys(parseSecrets(readText(path) ?? ''))
    const parts = secretParts(scope, present)
    // Every slot this release knows is listed, set or not: "API token" is a feature the panel has
    // whether or not one is minted, and hiding the row made its absence look like a missing feature
    // rather than an unset value. An unknown key in the file is listed too, as its own name.
    const known = KNOWN_SECRET_KEYS[scope]
    const missing = known.filter(key => !parts.some(part => part.key === key))
    return [
      ...parts.map(part => ({
        id: `${entryId}:${part.key}`,
        label: SECRET_LABELS[part.key]?.en ?? part.key,
        // A known secret gets a translated label and a hint saying what restoring it does;
        // an unknown one reads as its own key, which is still better than hiding it.
        ...(SECRET_LABELS[part.key] === undefined ? {} : { labelKey: SECRET_LABELS[part.key]!.key }),
        kind: 'secrets' as const,
        secret: part.key,
        included: true,
        note: null,
      })),
      ...missing.map(key => ({
        id: `${entryId}:${key}`,
        label: SECRET_LABELS[key]?.en ?? key,
        ...(SECRET_LABELS[key] === undefined ? {} : { labelKey: SECRET_LABELS[key]!.key }),
        kind: 'secrets' as const,
        secret: key,
        included: false,
        // The same wording and the same key as a missing file: both mean "this release knows about
        // it and there is nothing here yet". A second phrase for the same idea was the inconsistency.
        note: 'not set',
        noteKey: 'settings.backup.noteMissing',
      })),
    ]
  }

  private workspaceItems(workspace: BackupWorkspaceSource, includePaths: string[]): BackupEntry['items'] {
    const id = workspace.id
    const note = (path: string): Pick<BackupEntry['items'][number], 'note' | 'noteKey'> => {
      const absent = this.missingNote(path)
      return absent === null ? { note: null } : { note: absent, noteKey: 'settings.backup.noteMissing' }
    }
    const items: BackupEntry['items'] = [
      { id: `workspace:${id}:settings`, label: 'Settings', labelKey: 'settings.backup.leafSettings', kind: 'settings', included: true, ...note(workspace.settingsPath) },
      { id: `workspace:${id}:servers`, label: 'Servers', labelKey: 'settings.backup.leafServers', kind: 'servers', included: true, ...note(workspace.serversPath) },
      // The whole file keeps its own leaf — that id is what older clients send — and the
      // per-secret leaves beside it are what let one secret come back on its own.
      { id: `workspace:${id}:secrets`, label: 'Secrets', labelKey: 'settings.backup.leafSecrets', kind: 'secrets', included: true, ...note(workspace.secretsPath) },
      // One leaf per secret rather than one for the whole file, so restoring the Telegram
      // token cannot silently reinstate the DDNS credentials alongside it.
      ...this.secretItems('workspace', `workspace:${id}:secrets`, workspace.secretsPath),
    ]

    for (const declared of this.declaredData(workspace.servers, includePaths)) {
      items.push({
        id: `workspace:${id}:data:${declared.path}`,
        label: declared.path,
        kind: 'data',
        path: declared.path,
        origin: declared.origin,
        included: declared.included,
        note: declared.note,
        ...(declared.noteKey === undefined ? {} : { noteKey: declared.noteKey }),
        ...(declared.noteParams === undefined ? {} : { noteParams: declared.noteParams }),
        ignoreGenerated: declared.ignoreGenerated,
      })
    }

    return items
  }

  /**
   * Declared data paths with the archive-directory veto applied: capturing a
   * directory that contains the archive directory would make the archive
   * contain itself.
   */
  private declaredData(servers: ServerConfig[], includePaths: string[]): BackupPath[] {
    const archiveDir = path.resolve(this.resolveDir())
    return resolveBackupPaths(servers, includePaths, this.backupVars(servers)).map((entry) => {
      if (entry.included && isInside(entry.path, archiveDir))
        return { ...entry, included: false, note: 'contains the backup directory', noteKey: 'settings.backup.noteContainsBackupDir' }
      return entry
    })
  }

  /** The `{dataRoot}` a config expands to, without a module-level state root. */
  private backupVars(servers: ServerConfig[]): BackupVars {
    const first = servers[0]
    return {
      projectDir,
      // A server carries the panel's real `dataRoot`; the `.hh` directory the
      // panel hands us for `backups.dir` sits directly under it.
      dataRoot: first === undefined
        ? path.dirname(path.resolve(this.options.dataRoot))
        : String(serverTemplateVars(first).dataRoot ?? projectDir),
      home: os.homedir(),
    }
  }

  /** Newest-first listing, without the encryption flag, which needs a read. */
  private scan(): Array<Omit<BackupFile, 'encrypted'>> {
    const dir = this.resolveDir()
    let names: string[] = []
    try {
      names = fs.readdirSync(dir)
    }
    catch {
      return []
    }

    return names
      .filter(name => name.endsWith(SUFFIX))
      .flatMap((name) => {
        try {
          const stats = fs.statSync(path.join(dir, name))
          return [{ name, sizeBytes: stats.size, createdAt: Math.round(stats.mtimeMs) }]
        }
        catch {
          return []
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Single-flight: a state frame must never queue a pile of reads. */
  private scheduleRefresh(): Promise<void> {
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async refresh(): Promise<void> {
    const dir = this.resolveDir()
    const listed = this.scan()

    for (const file of listed) {
      const key = cacheKey(file)
      if (this.flags.get(file.name)?.key === key)
        continue
      try {
        const entries = await listZip(path.join(dir, file.name))
        this.flags.set(file.name, { key, encrypted: entries.some(entry => entry.encrypted) })
      }
      catch {
        // Unreadable stays unmarked here; restoring it reports the real reason.
        this.flags.set(file.name, { key, encrypted: false })
      }
    }

    const present = new Set(listed.map(file => file.name))
    for (const name of [...this.flags.keys()]) {
      if (!present.has(name))
        this.flags.delete(name)
    }
  }

  private missingNote(target: string): string | null {
    return fs.existsSync(target) ? null : 'not set'
  }

  /** Copies one source into the staging tree; false when there was nothing there. */
  private copyInto(staging: string, relative: string, source: string, ignoreGenerated = false): boolean {
    if (!fs.existsSync(source))
      return false
    const target = path.join(staging, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    // Never copy the archive directory into itself, however broad a declared
    // path is (`fs.cpSync` would walk it while writing into it).
    const archiveDir = path.resolve(this.resolveDir())
    const root = path.resolve(source)
    fs.cpSync(source, target, {
      recursive: true,
      force: true,
      filter: (from) => {
        const resolved = path.resolve(from)
        if (isInside(archiveDir, resolved))
          return false
        if (!ignoreGenerated || resolved === root)
          return true
        return !isGeneratedPath(path.relative(root, resolved))
      },
    })
    return true
  }

  /**
   * Drops the oldest archives past their own limit.
   *
   * Two budgets, because the two sources are not the same thing: `keep` is what a person
   * agreed to store, and pruning a hand-taken archive to make room for a scheduled one would
   * lose the copy they deliberately made. The scheduled pair keeps `schedule.keep` automatic
   * archives; the rest keeps `keep`.
   */
  private prune(): void {
    const config = this.options.getConfig()
    const files = this.list()
    const automatic = files.filter(isAutomatic)
    const manual = files.filter(file => !isAutomatic(file))

    for (const file of automatic.slice(config.schedule.keep)) this.remove(file.name)
    for (const file of manual.slice(config.keep)) this.remove(file.name)
  }

  /** When the newest automatic archive was written, or null when there is none. */
  private lastAutomatic(): number | null {
    return this.list().find(isAutomatic)?.createdAt ?? null
  }

  /**
   * Runs one scheduled pass when it is due. Modelled on the DDNS pass: cheap to call on every
   * panel tick, never blocking, and never two at once.
   */
  tick(now = Date.now()): void {
    if (this.disposed || this.running)
      return
    const config = this.options.getConfig()
    if (!config.enabled || config.schedule.intervalMs <= 0)
      return

    // The newest archive is the durable clock; the last attempt bounds a pass that wrote none.
    const last = this.lastAutomatic()
    const latest = last === null ? this.lastAttemptAt : Math.max(last, this.lastAttemptAt ?? 0)
    if (latest !== null && now - latest < config.schedule.intervalMs)
      return

    this.running = true
    this.lastAttemptAt = now
    // The configured scope, in the same `include`/`exclude` spelling a person types: an omitted
    // scope is the full default this pass has always taken, so an older config captures exactly
    // what it captured before.
    //
    // An id that no longer names anything (a workspace deleted since it was written) contributes
    // nothing, which is what it means in both modes. A `only` scope that has consequently lost
    // everything still meets `create`'s "nothing was selected" refusal, so a schedule that stopped
    // capturing says so on the page instead of writing archive after empty archive.
    void this.create({ automatic: true, ...scopeSelection(config.schedule.scope) })
      .then((result) => {
        // Remembered, not just logged: the page has nowhere else to show this, and a schedule
        // failing silently is indistinguishable from one that has not come due.
        if (result.ok) {
          this.scheduleError = null
          return
        }
        this.scheduleError = { message: result.error ?? 'the scheduled backup failed', at: Date.now() }
        logger.warn('the scheduled backup failed', result.error)
      })
      .catch((error: unknown) => {
        this.scheduleError = { message: errorMessage(error), at: Date.now() }
        logger.error('the scheduled backup failed', error)
      })
      .finally(() => {
        this.running = false
      })
  }

  private resolveDir(): string {
    const configured = this.options.getConfig().dir
    return path.isAbsolute(configured) ? configured : path.resolve(this.options.dataRoot, configured)
  }
}

/** Whether an archive came from the schedule rather than from a person. */
function isAutomatic(file: { name: string }): boolean {
  return file.name.startsWith(`${AUTO_PREFIX}-`)
}

/** The label of one item, for `applied`; items are built before actions run. */
function labelOf(plan: RestorePlan, id: string): string {
  return plan.items.find(item => item.id === id)?.label ?? id
}

/**
 * Restores only `fields` from an archived secrets document into a live one.
 *
 * The archive may predate a secret the live file holds, and the live file may hold one
 * the archive never carried: merging by field is what makes restoring the Telegram token
 * leave the DDNS credentials alone, and what clears a secret the archive does not carry
 * rather than leaving the newer value behind as if it had been restored.
 */
function mergeIntoFile(target: string, archived: string, fields: string[]): void {
  const current = parseSecrets(readText(target) ?? '')
  const merged = mergeSecrets(current, parseSecrets(archived), fields)
  writeFileAtomic(target, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
}

/**
 * What an archive says about where it came from. Both fields are absent on an archive
 * written before they existed, so a UI shows the row only when there is something to show.
 */
function manifestInfo(manifest: BackupManifest): NonNullable<RestorePlan['archive']> {
  return {
    ...(manifest.writtenBy === undefined ? {} : { writtenBy: manifest.writtenBy }),
    ...(manifest.schema === undefined ? {} : { schema: manifest.schema }),
  }
}

/**
 * `servers.config.json` is only a readability gate here: the store applies the
 * workspace's own defaults on the next load, and an archive from another machine
 * need not match this one's default shapes exactly.
 *
 * An older archive is lifted to this release's schema first, so its entries are adopted rather
 * than dropped; `null` means this release cannot read it at all.
 */
function readableServersFile(text: string): ServerConfig[] | null {
  try {
    const lifted = liftArchived(JSON.parse(text))
    if (lifted === null)
      return null
    const result = parseServersFile(lifted, {})
    return result.errors.length === 0 ? result.servers : null
  }
  catch {
    return null
  }
}

/** A workspace settings file is adopted only when this release can read it, lifted when older. */
function readableWorkspaceSettings(text: string): Record<string, unknown> | null {
  try {
    const lifted = liftArchived(JSON.parse(text))
    return lifted !== null && parseWorkspaceSettings(lifted).config !== null ? lifted : null
  }
  catch {
    return null
  }
}
