import type { TemplateVars } from '#src/helpers/template'
import type { BackupEntry, BackupFile, BackupsConfig, BackupsView, RestoreItem, RestorePlan, ServerConfig } from '#src/shared/contracts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseGlobalSettings, parseServersFile, parseWorkspaceSettings } from '#src/config/parse'
import { writeFileAtomic } from '#src/helpers/atomic'
import { expandEnv } from '#src/helpers/env-file'
import { projectDir, resolveUserPath } from '#src/helpers/paths'
import { resolveTemplate } from '#src/helpers/template'
import { createZip, extractZip, isInvalidPassword, isZipArchive, listZip } from '#src/providers/archive'
import { serverTemplateVars } from '#src/services/supervisor'
import { isGeneratedPath } from '#src/shared/generated'

const MANIFEST = 'manifest.json'
const ALLOWED_ROOTS = new Set(['global', 'workspaces', 'data'])
/** Every archive this service writes is a zip, encrypted or not. */
const SUFFIX = '.zip'
/** A workspace leaf that carries state the panel re-reads after a restore. */
const RELOADABLE = /^global:settings$|^workspace:[^:]+:(?:settings|servers)$/

/**
 * Structural allowlist for archive entries. A regex alone is not enough: `..`
 * is made of allowed characters, so segments are checked explicitly and any
 * entry that could resolve outside the staging directory aborts the restore.
 */
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
  return segments.every(segment => /^[\w.-]+$/.test(segment))
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
  const realParent = fs.existsSync(parent) ? fs.realpathSync(parent) : path.resolve(parent)
  return isInside(realParent, resolveExisting(path.resolve(child)))
}

/** One declared data path, with the verdict the UI shows. */
export interface BackupPath {
  path: string
  origin: string
  included: boolean
  note: string | null
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
    return { path: entry.path, origin: entry.origin, included: false, note, ignoreGenerated: entry.ignoreGenerated }
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

export interface BackupSources {
  globalSettingsPath: string
  globalSecretsPath: string
  tlsDir: string
  /** Extra paths in every backup, in addition to each server's own. */
  includePaths: string[]
  workspaces: BackupWorkspaceSource[]
}

export interface BackupManifest {
  version: 1
  createdAt: number
  hostname: string
  /** `origin` and `workspace` are what let a restore land under *this* machine's paths. */
  data: Array<{ slug: string, path: string, origin?: string, workspace?: string }>
}

export interface RestoreOptions {
  confirm: boolean
  /** Required for, and ignored by, archives that are not password-protected. */
  password?: string
  /** Item ids to restore; omitted means every restorable item. */
  include?: string[]
}

export type { RestorePlan }

/** One place a restore may write a data path to, and what declared it. */
interface DataTarget {
  workspace: string
  path: string
  origin: string
}

/**
 * A restored settings file is accepted when this release can read it — through
 * the same tolerant parser the stores use, so an archive from a newer release
 * keeps only the keys this one understands instead of being refused outright.
 */
function readableGlobalSettings(text: string | null): boolean {
  if (text === null)
    return false
  try {
    return parseGlobalSettings(JSON.parse(text)).config !== null
  }
  catch {
    return false
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

  constructor(
    private readonly options: {
      /** Relative `backups.dir` values resolve against it (the panel passes `$HHOSTED_HOME/.hh`). */
      dataRoot: string
      getConfig: () => BackupsConfig
      getSources: () => BackupSources
      /** Called after a restore wrote settings/server files; the panel re-reads everything. */
      onRestored?: () => void
    },
  ) {}

  /** Reads every archive once, so the first `list()` is already accurate. */
  async warm(): Promise<void> {
    await this.refresh()
  }

  get directory(): string {
    return this.resolveDir()
  }

  /** The whole two-level selection model the backup dialog reads. */
  view(): BackupsView {
    const config = this.options.getConfig()
    const sources = this.options.getSources()
    return {
      enabled: config.enabled,
      dir: this.directory,
      keep: config.keep,
      includePaths: [...sources.includePaths],
      entries: this.entries(sources),
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

  /** `password` encrypts the archive; it is never stored anywhere. */
  async create(options: { password?: string, include?: string[] } = {}): Promise<{ ok: boolean, file?: BackupFile, error?: string }> {
    const config = this.options.getConfig()
    if (!config.enabled)
      return { ok: false, error: 'backups are disabled' }

    const password = options.password !== undefined && options.password.length > 0 ? options.password : null
    // Omitted means everything; an id that names nothing is ignored, as on the restore side.
    const wanted = options.include === undefined ? null : new Set(options.include)
    const capturesGlobal = (id: string): boolean => wanted === null || wanted.has(id)
    // A workspace id alone means every leaf of that workspace.
    const capturesWorkspace = (id: string, suffix: string): boolean =>
      wanted === null || wanted.has(`workspace:${id}`) || wanted.has(`workspace:${id}:${suffix}`)

    const dir = this.resolveDir()
    const sources = this.options.getSources()
    const staging = path.join(dir, `.staging-${Date.now()}`)
    const createdAt = Date.now()
    // Milliseconds matter: two backups in the same second must not collide.
    const name = `backup-${new Date(createdAt).toISOString().replace(/[:T]/g, '-').replace(/\.\d+Z$/, '')}-${createdAt % 1000}${SUFFIX}`
    const destination = path.join(dir, name)

    try {
      fs.mkdirSync(staging, { recursive: true })
      let captured = 0
      const copy = (relative: string, source: string, ignoreGenerated = false): void => {
        if (this.copyInto(staging, relative, source, ignoreGenerated))
          captured++
      }

      if (capturesGlobal('global:settings'))
        copy('global/settings.json', sources.globalSettingsPath)
      if (capturesGlobal('global:secrets'))
        copy('global/secrets.json', sources.globalSecretsPath)
      if (capturesGlobal('global:tls'))
        copy('global/tls', sources.tlsDir)

      const data: BackupManifest['data'] = []
      for (const workspace of sources.workspaces) {
        const root = `workspaces/${workspace.id}`
        if (capturesWorkspace(workspace.id, 'settings'))
          copy(`${root}/settings.json`, workspace.settingsPath)
        if (capturesWorkspace(workspace.id, 'servers'))
          copy(`${root}/servers.config.json`, workspace.serversPath)
        if (capturesWorkspace(workspace.id, 'secrets'))
          copy(`${root}/secrets.json`, workspace.secretsPath)

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

      // A selection that captured nothing would only produce a manifest.
      if (wanted !== null && captured === 0) {
        fs.rmSync(staging, { recursive: true, force: true })
        return { ok: false, error: 'nothing was selected to back up' }
      }

      const manifest: BackupManifest = { version: 1, createdAt, hostname: os.hostname(), data }
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
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
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
    const password = options.password !== undefined && options.password.length > 0 ? options.password : null
    const plan: RestorePlan = {
      dryRun: !options.confirm,
      encrypted: false,
      needsPassword: false,
      items: [],
      applied: [],
      skipped: [],
      restartRequired: false,
      reloaded: false,
    }

    if (!isZipArchive(archivePath))
      return { ...plan, error: 'the archive is not a home-hosted backup (a zip file was expected)' }

    const staging = path.join(this.resolveDir(), `.restore-${Date.now()}`)

    try {
      // The central directory is readable without a password, so a backup can be
      // listed and its selection offered before the password is ever entered.
      let entries
      try {
        entries = await listZip(archivePath)
      }
      catch (error) {
        return { ...plan, error: `the archive could not be read: ${error instanceof Error ? error.message : String(error)}` }
      }

      plan.encrypted = entries.some(entry => entry.encrypted)
      if (plan.encrypted && password === null)
        return { ...plan, needsPassword: true, error: 'this backup is password-protected' }

      if (entries.length === 0)
        return { ...plan, error: 'the archive is empty' }
      if (entries.length > 100_000)
        return { ...plan, error: 'the archive has too many entries' }

      const invalid = entries.filter(entry => !isSafeArchiveEntry(entry.name))
      if (invalid.length > 0) {
        return { ...plan, error: `the archive contains unexpected entries (e.g. ${invalid.slice(0, 3).map(entry => entry.name).join(', ')})` }
      }

      fs.mkdirSync(staging, { recursive: true })
      const extracted = await extractZip(archivePath, staging, {
        names: entries.map(entry => entry.name),
        ...(password === null ? {} : { password }),
      })
      for (const name of extracted.skipped)
        plan.skipped.push(`${name} (symbolic link, skipped)`)

      const manifestPath = path.join(staging, MANIFEST)
      if (!fs.existsSync(manifestPath))
        return { ...plan, error: 'the archive has no manifest' }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest

      const sources = this.options.getSources()
      const selectedIds = options.include === undefined ? null : new Set(options.include)
      const actions = new Map<string, () => void>()

      const addItem = (item: Omit<RestoreItem, 'selected'>, apply: (() => void) | null, aliases: string[] = []): void => {
        if (apply === null) {
          plan.items.push({ ...item, selected: false })
          plan.skipped.push(`${item.label}${item.note === null ? '' : ` (${item.note})`}`)
          return
        }
        const selected = selectedIds === null
          || selectedIds.has(item.id)
          || aliases.some(alias => selectedIds.has(alias))
        plan.items.push({ ...item, selected })
        if (selected)
          actions.set(item.id, apply)
        else
          plan.skipped.push(`${item.label} (not selected)`)
      }

      // ---------------------------------------------------------------- global
      const settingsText = readText(path.join(staging, 'global', 'settings.json'))
      const parsedGlobal = readableGlobalSettings(settingsText) ? parseGlobalSettings(JSON.parse(settingsText!)).config : null
      if (settingsText !== null && parsedGlobal === null)
        plan.skipped.push('Global settings (the archive\'s settings are not valid)')
      if (parsedGlobal !== null && settingsText !== null) {
        addItem({ id: 'global:settings', label: 'Global settings', kind: 'settings', restorable: true, note: null }, () => {
          writeFileAtomic(sources.globalSettingsPath, settingsText)
        }, ['config'])
      }

      const globalSecrets = readText(path.join(staging, 'global', 'secrets.json'))
      if (globalSecrets !== null) {
        addItem({ id: 'global:secrets', label: 'Global secrets (password, API token)', kind: 'secrets', restorable: true, note: null }, () => {
          writeFileAtomic(sources.globalSecretsPath, globalSecrets, { mode: 0o600 })
        }, ['secrets'])
      }

      const tlsInArchive = path.join(staging, 'global', 'tls')
      if (fs.existsSync(tlsInArchive)) {
        const files = fs.readdirSync(tlsInArchive).filter(file => fs.statSync(path.join(tlsInArchive, file)).isFile())
        addItem({ id: 'global:tls', label: 'TLS certificate', kind: 'tls', restorable: true, note: null }, () => {
          fs.mkdirSync(sources.tlsDir, { recursive: true })
          for (const file of files) {
            const mode = file.endsWith('.key.pem') ? { mode: 0o600 } : {}
            writeFileAtomic(path.join(sources.tlsDir, file), fs.readFileSync(path.join(tlsInArchive, file), 'utf8'), mode)
          }
        }, ['tls'])
      }

      // ------------------------------------------------------------ workspaces
      /** Every archived servers file this release can read, selected or not. */
      const archivedServers = new Map<string, ServerConfig[]>()

      const archiveWorkspaces = path.join(staging, 'workspaces')
      if (fs.existsSync(archiveWorkspaces)) {
        for (const entry of fs.readdirSync(archiveWorkspaces, { withFileTypes: true })) {
          if (!entry.isDirectory())
            continue
          const id = entry.name
          const dir = path.join(archiveWorkspaces, id)
          const workspace = sources.workspaces.find(candidate => candidate.id === id)
          const settings = readText(path.join(dir, 'settings.json'))
          const servers = readText(path.join(dir, 'servers.config.json'))
          const secrets = readText(path.join(dir, 'secrets.json'))

          if (workspace === undefined) {
            const leaves = [['settings', 'Settings', settings], ['servers', 'Servers', servers], ['secrets', 'Secrets', secrets]] as const
            for (const [suffix, label, text] of leaves) {
              if (text === null)
                continue
              addItem({
                id: `workspace:${id}:${suffix}`,
                label: `${id}: ${label}`,
                kind: suffix,
                workspaceId: id,
                restorable: false,
                note: 'unknown workspace',
              }, null)
            }
            continue
          }

          if (settings !== null) {
            if (readableWorkspaceSettings(settings)) {
              addItem({ id: `workspace:${id}:settings`, label: `${workspace.label}: Settings`, kind: 'settings', workspaceId: id, restorable: true, note: null }, () => {
                writeFileAtomic(workspace.settingsPath, settings)
              })
            }
            else {
              plan.skipped.push(`${workspace.label}: Settings (the archive's settings are not valid)`)
            }
          }

          if (servers !== null) {
            const parsed = readableServersFile(servers)
            if (parsed !== null) {
              archivedServers.set(id, parsed)
              addItem({ id: `workspace:${id}:servers`, label: `${workspace.label}: Servers`, kind: 'servers', workspaceId: id, restorable: true, note: null }, () => {
                writeFileAtomic(workspace.serversPath, servers)
              })
            }
            else {
              plan.skipped.push(`${workspace.label}: Servers (the archive's servers are not valid)`)
            }
          }

          if (secrets !== null) {
            addItem({ id: `workspace:${id}:secrets`, label: `${workspace.label}: Secrets`, kind: 'secrets', workspaceId: id, restorable: true, note: null }, () => {
              writeFileAtomic(workspace.secretsPath, secrets, { mode: 0o600 })
            })
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
      const matchTarget = (origin: string | undefined, workspace: string | undefined, archivedPath: string): DataTarget | undefined => {
        if (origin !== undefined) {
          if (workspace !== undefined) {
            const scoped = take(archiveTargets, usedArchive, target => target.origin === origin && target.workspace === workspace)
              ?? take(instanceTargets, usedInstance, target => target.origin === origin && target.workspace === workspace)
            if (scoped !== undefined)
              return scoped
          }
          return take(archiveTargets, usedArchive, target => target.origin === origin)
            ?? take(instanceTargets, usedInstance, target => target.origin === origin)
            ?? take(archiveTargets, usedArchive, target => target.path === archivedPath)
            ?? take(instanceTargets, usedInstance, target => target.path === archivedPath)
        }
        return take(archiveTargets, usedArchive, target => target.path === archivedPath)
          ?? take(instanceTargets, usedInstance, target => target.path === archivedPath)
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
          }, null, aliases)
          continue
        }
        if (!fs.existsSync(from)) {
          addItem({ ...base, note: 'missing from the archive' }, null, aliases)
          continue
        }

        addItem(
          { ...base, restorable: true, note: target.path === archivedPath ? null : `restored from ${archivedPath}` },
          // `cpSync` follows symlinks already in the destination tree, so a link
          // standing inside the declared path would carry the archive's files out of
          // it. The destination of each entry is what is checked, because that is
          // where the link is resolved; the links themselves are never recreated,
          // which is the stated invariant.
          () => fs.cpSync(from, target.path, {
            recursive: true,
            force: true,
            filter: (_source, destination) => isInsideResolved(target.path, destination),
          }),
          aliases,
        )
      }

      // The plan has to say whether a restart is needed even in a dry run: only
      // the panel's own listener does, its servers are re-read from the file.
      if (parsedGlobal !== null && actions.has('global:settings') && settingsText !== null) {
        const currentText = readText(sources.globalSettingsPath)
        const current = readableGlobalSettings(currentText) ? parseGlobalSettings(JSON.parse(currentText!)).config : null
        plan.restartRequired = JSON.stringify(parsedGlobal.control) !== JSON.stringify(current?.control ?? null)
      }

      if (!options.confirm) {
        // A dry run reports what *would* happen, so the UI can show the plan
        // and the selection before anything is written.
        plan.applied = [...actions.keys()].map(id => labelOf(plan, id))
        return plan
      }

      for (const [id, apply] of actions) {
        apply()
        plan.applied.push(labelOf(plan, id))
      }

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
      return { ...plan, error: `${error instanceof Error ? error.message : String(error)}${done}` }
    }
    finally {
      fs.rmSync(staging, { recursive: true, force: true })
    }
  }

  /** Selectable entries: the three global slices, then one per workspace. */
  private entries(sources: BackupSources): BackupEntry[] {
    const entries: BackupEntry[] = [
      { id: 'global:settings', label: 'Global settings', kind: 'settings', note: this.missingNote(sources.globalSettingsPath), items: [] },
      { id: 'global:secrets', label: 'Global secrets (password, API token)', kind: 'secrets', note: this.missingNote(sources.globalSecretsPath), items: [] },
      { id: 'global:tls', label: 'TLS certificate', kind: 'tls', note: this.missingNote(sources.tlsDir), items: [] },
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

  private workspaceItems(workspace: BackupWorkspaceSource, includePaths: string[]): BackupEntry['items'] {
    const id = workspace.id
    const items: BackupEntry['items'] = [
      { id: `workspace:${id}:settings`, label: 'Settings', kind: 'settings', included: true, note: this.missingNote(workspace.settingsPath) },
      { id: `workspace:${id}:servers`, label: 'Servers', kind: 'servers', included: true, note: this.missingNote(workspace.serversPath) },
      { id: `workspace:${id}:secrets`, label: 'Secrets', kind: 'secrets', included: true, note: this.missingNote(workspace.secretsPath) },
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
        return { ...entry, included: false, note: 'contains the backup directory' }
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
    return fs.existsSync(target) ? null : 'does not exist yet'
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

  private prune(): void {
    const { keep } = this.options.getConfig()
    for (const file of this.list().slice(keep)) this.remove(file.name)
  }

  private resolveDir(): string {
    const configured = this.options.getConfig().dir
    return path.isAbsolute(configured) ? configured : path.resolve(this.options.dataRoot, configured)
  }
}

/** The label of one item, for `applied`; items are built before actions run. */
function labelOf(plan: RestorePlan, id: string): string {
  return plan.items.find(item => item.id === id)?.label ?? id
}

/**
 * `servers.config.json` is only a readability gate here: the store applies the
 * workspace's own defaults on the next load, and an archive from another machine
 * need not match this one's default shapes exactly.
 */
function readableServersFile(text: string): ServerConfig[] | null {
  try {
    const result = parseServersFile(JSON.parse(text), {})
    return result.errors.length === 0 ? result.servers : null
  }
  catch {
    return null
  }
}

/** A workspace settings file is adopted only when this release can read it. */
function readableWorkspaceSettings(text: string): boolean {
  try {
    return parseWorkspaceSettings(JSON.parse(text)).config !== null
  }
  catch {
    return false
  }
}
