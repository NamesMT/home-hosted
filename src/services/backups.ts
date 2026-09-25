import type { BackupFile, BackupPath, BackupsConfig, ServerConfig } from '#src/shared/contracts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseConfig } from '#src/config/parse'
import { writeFileAtomic } from '#src/helpers/atomic'
import { expandEnv } from '#src/helpers/env-file'
import { dataRoot, projectDir, resolveUserPath } from '#src/helpers/paths'
import { resolveTemplate } from '#src/helpers/template'
import { createZip, extractZip, isInvalidPassword, isZipArchive, listZip } from '#src/providers/archive'
import { serverTemplateVars } from '#src/services/supervisor'
import { isGeneratedPath } from '#src/shared/generated'

const MANIFEST = 'manifest.json'
const ALLOWED_ROOTS = new Set(['config', 'secrets', 'tls', 'data'])
/** Every archive this service writes is a zip, encrypted or not. */
const SUFFIX = '.zip'

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
  if (cleaned === 'manifest.json')
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
 */
export function resolveBackupPaths(servers: ServerConfig[], includePaths: string[] = []): BackupPath[] {
  const declared: DeclaredPath[] = []
  const globalVars = { projectDir, dataRoot, home: os.homedir() }

  const add = (value: string, origin: string, vars: Record<string, string | number>, ignoreGenerated: boolean): void => {
    if (value.trim().length === 0)
      return
    // Normalized, so a trailing slash or a doubled one cannot defeat the
    // parent/child comparison below.
    const resolved = path.normalize(resolveUserPath(expandEnv(resolveTemplate(value, vars), process.env)))
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
    const vars = serverTemplateVars(config)
    const ignoreGenerated = config.backupIgnoreGenerated !== false
    for (const [name, value] of Object.entries(config.dataEnvs)) add(value, `${config.id}:${name}`, vars, ignoreGenerated)
    for (const value of config.backupPaths) add(value, `${config.id}:backupPaths`, vars, ignoreGenerated)
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

export interface BackupSources {
  configPath: string
  secretsPath: string
  tlsDir: string
  /** Declared paths, resolved, with their origin and inclusion verdict. */
  paths: BackupPath[]
}

export interface BackupManifest {
  version: 1
  createdAt: number
  hostname: string
  /** `origin` is what lets a restore land under *this* machine's paths. */
  data: Array<{ slug: string, path: string, origin?: string }>
}

export interface RestoreOptions {
  confirm: boolean
  /** Required for, and ignored by, archives that are not password-protected. */
  password?: string
  /** Item ids to restore; omitted means every restorable item. */
  include?: string[]
}

export interface RestorePlan {
  dryRun: boolean
  encrypted: boolean
  needsPassword: boolean
  items: Array<{
    id: string
    label: string
    kind: 'config' | 'secrets' | 'tls' | 'data'
    restorable: boolean
    selected: boolean
    note: string | null
  }>
  applied: string[]
  skipped: string[]
  restartRequired: boolean
  /** The panel re-read the restored config in this same run. */
  reloaded: boolean
  error?: string
}

/** One place a restore may write a data path to, and what declared it. */
interface DeclaredTarget {
  path: string
  origin: string
}

/** The panel's own listener is the only thing a restart is needed for. */
function controlBlock(configText: string | null): unknown {
  try {
    return (JSON.parse(configText ?? '{}') as { control?: unknown }).control ?? null
  }
  catch {
    return null
  }
}

/**
 * A restored config is accepted when this release can read it — through the same
 * tolerant parser the store uses, so an archive from a newer release keeps only
 * the keys this one understands instead of being refused outright.
 */
function isUsableConfig(text: string | null): boolean {
  if (text === null)
    return false
  try {
    return parseConfig(JSON.parse(text)).config !== null
  }
  catch {
    return false
  }
}

/**
 * The data paths the archive's own config declares, resolved against *this*
 * machine — so a backup made with `{home}` templates restores under this user's
 * paths, and one restored onto a blank instance brings its servers with it.
 */
function archiveTargets(configText: string | null): DeclaredTarget[] {
  if (configText === null)
    return []
  try {
    const parsed = parseConfig(JSON.parse(configText)).config
    if (parsed === null)
      return []
    return resolveBackupPaths(parsed.servers, parsed.backups.includePaths)
      .filter(entry => entry.included)
      .map(entry => ({ path: entry.path, origin: entry.origin }))
  }
  catch {
    return []
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

/**
 * Archives of the control plane's own state plus whatever paths the config
 * declares. Two rules keep restore safe: the archive layout is an allowlist, and
 * a data path is only written back when the *current* config still declares it —
 * an uploaded archive can never choose where to write.
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
      /** Relative `backups.dir` values resolve against it. */
      dataRoot: string
      getConfig: () => BackupsConfig
      getSources: () => BackupSources
      /** Called after this instance's own config was overwritten by a restore. */
      onConfigRestored?: () => void
    },
  ) {}

  /** Reads every archive once, so the first `list()` is already accurate. */
  async warm(): Promise<void> {
    await this.refresh()
  }

  get directory(): string {
    return this.resolveDir()
  }

  /** Declared paths with their verdict, as the UI shows them. */
  get paths(): BackupPath[] {
    const dir = path.resolve(this.resolveDir())
    return this.options.getSources().paths.map((entry) => {
      // Capturing a directory that contains the archive directory would make the
      // archive contain itself.
      if (isInside(entry.path, dir))
        return { ...entry, included: false, note: 'contains the backup directory' }
      return entry
    })
  }

  /** Only what actually goes into a backup. */
  get dataPaths(): string[] {
    return this.paths.filter(entry => entry.included).map(entry => entry.path)
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
  async create(options: { password?: string } = {}): Promise<{ ok: boolean, file?: BackupFile, error?: string }> {
    const config = this.options.getConfig()
    if (!config.enabled)
      return { ok: false, error: 'backups are disabled' }

    const password = options.password !== undefined && options.password.length > 0 ? options.password : null

    const dir = this.resolveDir()
    const sources = this.options.getSources()
    const staging = path.join(dir, `.staging-${Date.now()}`)
    const createdAt = Date.now()
    // Milliseconds matter: two backups in the same second must not collide.
    const name = `backup-${new Date(createdAt).toISOString().replace(/[:T]/g, '-').replace(/\.\d+Z$/, '')}-${createdAt % 1000}${SUFFIX}`
    const destination = path.join(dir, name)

    try {
      fs.mkdirSync(staging, { recursive: true })
      this.copyInto(staging, 'config/servers.config.json', sources.configPath)
      this.copyInto(staging, 'secrets/control-secrets.json', sources.secretsPath)
      this.copyInto(staging, 'tls', sources.tlsDir)

      const data: BackupManifest['data'] = []
      for (const declared of this.paths) {
        if (!declared.included || !fs.existsSync(declared.path))
          continue
        const slug = slugifyPath(declared.path)
        if (data.some(entry => entry.slug === slug))
          continue
        this.copyInto(staging, path.join('data', slug), declared.path, declared.ignoreGenerated === true)
        data.push({ slug, path: declared.path, origin: declared.origin })
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
   * its items were selected. Data paths come from the *current* config, never
   * from the archive's manifest.
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
      const configInArchive = path.join(staging, 'config', 'servers.config.json')
      const secretsInArchive = path.join(staging, 'secrets', 'control-secrets.json')
      const tlsInArchive = path.join(staging, 'tls')

      const selectedIds = options.include === undefined ? null : new Set(options.include)
      const actions = new Map<string, () => void>()

      const addItem = (item: RestorePlan['items'][number], apply: (() => void) | null): void => {
        if (apply === null) {
          plan.items.push({ ...item, selected: false })
          plan.skipped.push(`${item.label}${item.note === null ? '' : ` (${item.note})`}`)
          return
        }
        const selected = selectedIds === null || selectedIds.has(item.id)
        plan.items.push({ ...item, selected })
        if (selected) {
          actions.set(item.id, apply)
        }
        else {
          plan.skipped.push(`${item.label} (not selected)`)
        }
      }

      const archivedConfig = fs.existsSync(configInArchive) ? fs.readFileSync(configInArchive, 'utf8') : null
      // A config from an archive replaces the live one, so it has to validate
      // first — otherwise a malformed upload silently removes every server.
      const restoredConfig = isUsableConfig(archivedConfig) ? archivedConfig : null
      if (archivedConfig !== null && restoredConfig === null)
        plan.skipped.push('config/servers.config.json (the archive\'s config is not valid)')
      if (restoredConfig !== null) {
        addItem({ id: 'config', label: 'config/servers.config.json', kind: 'config', restorable: true, selected: false, note: null }, () => {
          writeFileAtomic(sources.configPath, restoredConfig)
        })
      }
      if (fs.existsSync(secretsInArchive)) {
        const restored = fs.readFileSync(secretsInArchive, 'utf8')
        addItem({ id: 'secrets', label: 'secrets/control-secrets.json', kind: 'secrets', restorable: true, selected: false, note: null }, () => {
          writeFileAtomic(sources.secretsPath, restored, { mode: 0o600 })
        })
      }
      if (fs.existsSync(tlsInArchive)) {
        const files = fs.readdirSync(tlsInArchive).filter(file => fs.statSync(path.join(tlsInArchive, file)).isFile())
        addItem({ id: 'tls', label: 'tls/', kind: 'tls', restorable: true, selected: false, note: null }, () => {
          fs.mkdirSync(sources.tlsDir, { recursive: true })
          for (const file of files) {
            const from = path.join(tlsInArchive, file)
            const mode = file.endsWith('.key.pem') ? { mode: 0o600 } : {}
            writeFileAtomic(path.join(sources.tlsDir, file), fs.readFileSync(from, 'utf8'), mode)
          }
        })
      }

      // A data path is written to a path a *config* declares — this instance's, or
      // the one the archive brings. That second source is what makes a blank
      // instance restorable: the backup's own `servers.config.json` names its data
      // directories, so restoring the config restores the whole setup.
      const fromArchive = archiveTargets(restoredConfig)
      const candidates: DeclaredTarget[] = [
        // The restored config wins, because it is the one that will be live.
        ...(actions.has('config') ? fromArchive : []),
        ...this.paths.filter(entry => entry.included).map(entry => ({ path: entry.path, origin: entry.origin })),
      ]

      for (const entry of manifest.data ?? []) {
        const target = candidates.find(candidate => entry.origin !== undefined && candidate.origin === entry.origin)
          ?? candidates.find(candidate => candidate.path === entry.path)
        const from = path.join(staging, 'data', safeSlug(entry.slug) ?? slugifyPath(entry.path))
        const common = {
          id: `data:${entry.path}`,
          label: target?.path ?? entry.path,
          kind: 'data' as const,
          restorable: false,
          selected: false,
          note: null,
        }

        if (target === undefined) {
          const archiveOnly = fromArchive.some(candidate => candidate.origin === entry.origin)
          addItem({
            ...common,
            note: archiveOnly && !actions.has('config')
              ? 'declared by the backup\'s config, which is not being restored'
              : 'not declared by this config, nor by the backup',
          }, null)
          continue
        }
        if (!fs.existsSync(from)) {
          addItem({ ...common, note: 'missing from the archive' }, null)
          continue
        }

        addItem(
          { ...common, restorable: true, note: target.path === entry.path ? null : `restored from ${entry.path}` },
          () => fs.cpSync(from, target.path, { recursive: true, force: true }),
        )
      }

      // The plan has to say whether a restart is needed even in a dry run: only
      // the panel's own listener does, the servers are re-read from the file.
      if (restoredConfig !== null && actions.has('config')) {
        const current = fs.existsSync(sources.configPath) ? fs.readFileSync(sources.configPath, 'utf8') : null
        plan.restartRequired = JSON.stringify(controlBlock(restoredConfig)) !== JSON.stringify(controlBlock(current))
      }

      if (!options.confirm) {
        // A dry run reports what *would* happen, so the UI can show the plan
        // and the selection before anything is written.
        plan.applied = [...actions.keys()].map(id => plan.items.find(item => item.id === id)!.label)
        return plan
      }

      for (const [id, apply] of actions) {
        apply()
        plan.applied.push(plan.items.find(item => item.id === id)!.label)
      }

      if (actions.has('config') && this.options.onConfigRestored !== undefined) {
        plan.reloaded = true
        // The panel re-reads the restored file here, so the servers it declares
        // exist immediately instead of after a restart.
        this.options.onConfigRestored()
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

  private copyInto(staging: string, relative: string, source: string, ignoreGenerated = false): void {
    if (!fs.existsSync(source))
      return
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
