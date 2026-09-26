import type { ArchiveEntry } from '#src/providers/archive'
import type { UiMeta, UiStatus } from '#src/shared/contracts'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { type } from 'arktype'
import { writeFileAtomic } from '#src/helpers/atomic'
import { extractZip, isZipArchive, listZip } from '#src/providers/archive'
import { uiMetaSchema } from '#src/shared/contracts'

/**
 * The panel's UI is replaceable: the stock SPA ships in the package, and a user
 * can put their own build in `$HHOSTED_HOME/.ui` — by hand, or by uploading a zip
 * in the settings page. Everything that serves files asks `resolveDir()` per
 * request, so an install (or `home-hosted ui-revert`) applies on the next refresh.
 */

const META = 'ui.json'
/** A UI is static files; these caps keep a hostile or accidental archive harmless. */
const MAX_ENTRIES = 20_000
const MAX_BYTES = 512 * 1024 * 1024
const MAX_NAME = 120

/** What a UI author may declare in a root `ui.json` inside their archive. */
const manifestSchema = type({
  'name?': 'string',
  'version?': 'string',
  'repo?': 'string',
  'tag?': 'string',
  'asset?': 'string',
  'unix?': 'number.integer >= 0',
})

/**
 * A UI archive is a static site: relative paths only, no traversal, no absolute
 * paths, no drive letters, and an `index.html` to serve. Symlinks are dropped by
 * the extractor.
 */
export function isSafeUiEntry(entry: string): boolean {
  if (entry.length === 0 || entry.length > MAX_NAME)
    return false
  if (entry.startsWith('/') || entry.includes('\\') || entry.includes('\0'))
    return false

  const cleaned = entry.replace(/^\.\//, '').replace(/\/+$/, '')
  if (cleaned.length === 0)
    return false
  return cleaned.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' && !segment.includes(':'))
}

export type UiInstallResult
  = | { ok: true, meta: UiMeta }
    | { ok: false, error: string }

export class UiService {
  constructor(private readonly options: { dataRoot: string, stockDir?: string }) {}

  /** `$HHOSTED_HOME/.ui` — the only place a user UI is ever read from. */
  get directory(): string {
    return path.join(this.options.dataRoot, '.ui')
  }

  /** True when a user UI is installed and complete. */
  get custom(): boolean {
    return fs.existsSync(path.join(this.directory, 'index.html'))
  }

  /** What the panel should serve right now. */
  resolveDir(): string {
    if (this.custom)
      return this.directory
    return this.options.stockDir ?? this.directory
  }

  status(): UiStatus {
    return { custom: this.custom, dir: this.directory, meta: this.readMeta() }
  }

  readMeta(): UiMeta | null {
    try {
      const parsed = uiMetaSchema(JSON.parse(fs.readFileSync(path.join(this.directory, META), 'utf8')))
      return parsed instanceof type.errors ? null : parsed
    }
    catch {
      return null
    }
  }

  /**
   * Installs a UI from a zip. The archive is extracted beside `.ui` and only then
   * swapped in, so a failed upload leaves the previous UI (or the stock one)
   * serving.
   */
  async install(archivePath: string, fallbackName = 'custom-ui', installedTag?: string): Promise<UiInstallResult> {
    if (!isZipArchive(archivePath))
      return { ok: false, error: 'the upload is not a zip archive' }

    // Unique per attempt, not just per millisecond: two installs starting together would
    // otherwise stage into the same directory and rename each other's tree away.
    const staging = path.join(this.options.dataRoot, `.ui-staging-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

    try {
      return await this.stage(archivePath, staging, fallbackName, installedTag)
    }
    catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    finally {
      fs.rmSync(staging, { recursive: true, force: true })
    }
  }

  /** Removes the user UI, putting the stock panel back. */
  revert(): boolean {
    const existed = fs.existsSync(this.directory)
    fs.rmSync(this.directory, { recursive: true, force: true })
    return existed
  }

  private async stage(archivePath: string, staging: string, fallbackName: string, installedTag?: string): Promise<UiInstallResult> {
    let entries: ArchiveEntry[]
    try {
      entries = await listZip(archivePath)
    }
    catch (error) {
      return { ok: false, error: `the archive could not be read: ${error instanceof Error ? error.message : String(error)}` }
    }

    if (entries.length === 0)
      return { ok: false, error: 'the archive is empty' }
    if (entries.length > MAX_ENTRIES)
      return { ok: false, error: `the archive has more than ${MAX_ENTRIES} entries` }

    const bytes = entries.reduce((total, entry) => total + entry.size, 0)
    if (bytes > MAX_BYTES)
      return { ok: false, error: `the archive is larger than ${Math.round(MAX_BYTES / 1024 / 1024)}MB uncompressed` }

    const unusable = entries.find(entry => !isSafeUiEntry(entry.name))
    if (unusable !== undefined)
      return { ok: false, error: `the archive contains an unusable path: ${unusable.name}` }

    fs.mkdirSync(staging, { recursive: true })
    await extractZip(archivePath, staging, { names: entries.map(entry => entry.name) })

    const root = resolveRoot(staging)
    if (root === null)
      return { ok: false, error: 'the archive has no index.html at its root' }

    const manifest = readManifest(root)
    const meta: UiMeta = {
      name: manifest?.name ?? fallbackName,
      version: manifest?.version ?? null,
      uploadedAt: Date.now(),
      files: countFiles(root),
      // The declared identity is carried into the installed metadata, so `ui-update` can
      // still tell which release this UI came from long after the zip is gone. Omitted
      // rather than defaulted: a UI that declares nothing has nothing to say here.
      ...(manifest?.repo === undefined ? {} : { repo: manifest.repo }),
      // The caller that fetched this from a release knows the tag better than the archive
      // does: a UI zip is built *before* the release is cut, so its own `tag` is the
      // previous release at best. Recording the archive's value here is what made a panel
      // re-download and re-install the same UI on every boot.
      ...(installedTag !== undefined ? { tag: installedTag } : manifest?.tag === undefined ? {} : { tag: manifest.tag }),
      ...(manifest?.asset === undefined ? {} : { asset: manifest.asset }),
      ...(manifest?.unix === undefined ? {} : { unix: manifest.unix }),
    }

    // Metadata is written while the tree is still in staging, so the swap below is two
    // renames and nothing else — the window where `.ui` does not exist shrinks to that.
    writeFileAtomic(path.join(root, META), `${JSON.stringify(meta, null, 2)}\n`)

    return commitSwap(this.options.dataRoot, this.directory, root, meta)
  }

  /**
   * Puts a half-finished install back together, and is safe to call on every boot.
   *
   * An install that was interrupted between its two renames — a kill, a power cut, a
   * crash — leaves `.ui` missing with the user's only copy sitting in a `.previous-*`
   * sibling. Without this the panel would quietly serve the stock UI forever, because
   * `custom` is false and nothing ever looked at the backup.
   */
  recover(): { restored: string | null, swept: number } {
    const resting = this.directory
    let restored: string | null = null

    if (!fs.existsSync(path.join(resting, 'index.html'))) {
      const backup = newestBackup(this.options.dataRoot, resting)
      if (backup !== null) {
        fs.rmSync(resting, { recursive: true, force: true })
        fs.renameSync(backup, resting)
        restored = path.basename(backup)
      }
    }

    // Only after the live tree is whole again: a leftover backup is the last resort.
    return { restored, swept: sweepJunk(this.options.dataRoot) }
  }
}

/**
 * Serializes installs per data root. `Settings → Interface`, the boot hook and a second
 * panel can all reach the same `.ui`, and two interleaved swaps could leave it absent.
 * The key is the directory rather than the instance: every caller builds its own
 * `UiService`. Cross-process overlap is still possible, which is why the swap is
 * crash-recoverable — this closes the window that was open *within* a process.
 */
const installLocks = new Map<string, Promise<unknown>>()

function withInstallLock<T>(dataRoot: string, run: () => Promise<T>): Promise<T> {
  const key = path.resolve(dataRoot)
  const previous = installLocks.get(key) ?? Promise.resolve()
  // Chain whether or not the predecessor succeeded: a failed install must not wedge the lock.
  const next = previous.then(run, run)
  installLocks.set(key, next.catch(() => {}))
  return next
}

/** Renames the staged tree into place, keeping the old one until that has certainly worked. */
function commitSwap(dataRoot: string, resting: string, staged: string, meta: UiMeta): Promise<UiInstallResult> {
  return withInstallLock(dataRoot, async () => {
    // One rename, and no window at all: POSIX renames a directory onto an existing one.
    try {
      fs.renameSync(staged, resting)
    }
    catch {
      // Windows refuses that when the target is a non-empty directory, so the old tree
      // steps aside first — immediately, with no I/O in between.
      const previous = `${resting}.previous-${process.pid}-${Date.now()}`
      const hadPrevious = fs.existsSync(resting)
      if (hadPrevious)
        fs.renameSync(resting, previous)

      try {
        fs.renameSync(staged, resting)
      }
      catch (error) {
        // Put the user's UI back before reporting. If even that fails, keep the backup
        // and say where it is — deleting it would destroy the only copy.
        try {
          fs.rmSync(resting, { recursive: true, force: true })
          if (hadPrevious && fs.existsSync(previous))
            fs.renameSync(previous, resting)
          fs.rmSync(previous, { recursive: true, force: true })
        }
        catch {
          return { ok: false, error: `${describeError(error)} — the previous UI is kept at ${previous}` }
        }
        return { ok: false, error: describeError(error) }
      }

      fs.rmSync(previous, { recursive: true, force: true })
    }

    // Any backup older than this successful swap is now unreferenced; sweep them so an
    // interrupted install cannot leave a pile of stale full copies behind.
    sweepBackups(dataRoot, resting)
    return { ok: true, meta }
  })
}

function sweepBackups(dataRoot: string, resting: string): void {
  const prefix = `${path.basename(resting)}.previous-`
  for (const entry of readDataRoot(dataRoot)) {
    if (entry.startsWith(prefix))
      fs.rmSync(path.join(dataRoot, entry), { recursive: true, force: true })
  }
}

/** The most recently abandoned UI tree, or null when there is not one. */
function newestBackup(dataRoot: string, resting: string): string | null {
  const prefix = `${path.basename(resting)}.previous-`
  let best: string | null = null
  let bestStamp = -1

  for (const entry of readDataRoot(dataRoot)) {
    if (!entry.startsWith(prefix))
      continue
    const full = path.join(dataRoot, entry)
    if (!fs.existsSync(path.join(full, 'index.html')))
      continue
    // `<name>.previous-<pid>-<stamp>`: the longest stamp is the newest attempt.
    const stamp = Number(entry.slice(prefix.length).split('-').pop() ?? '')
    if (Number.isFinite(stamp) && stamp > bestStamp) {
      bestStamp = stamp
      best = full
    }
  }
  return best
}

/** Dropped staging trees and superseded backups, once the live UI is whole. */
function sweepJunk(dataRoot: string): number {
  let swept = 0
  for (const entry of readDataRoot(dataRoot)) {
    if (!entry.startsWith('.ui-staging-') && !entry.startsWith(`.ui.previous-`))
      continue
    fs.rmSync(path.join(dataRoot, entry), { recursive: true, force: true })
    swept += 1
  }
  return swept
}

function readDataRoot(dataRoot: string): string[] {
  try {
    return fs.readdirSync(dataRoot)
  }
  catch {
    return []
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Where the site actually starts: the archive root, or a single wrapper directory
 * (`zip -r ui.zip dist` is a common way to build one).
 */
function resolveRoot(staging: string): string | null {
  if (fs.existsSync(path.join(staging, 'index.html')))
    return staging

  const directories = fs.readdirSync(staging, { withFileTypes: true }).filter(entry => entry.isDirectory())
  if (directories.length !== 1)
    return null

  const inner = path.join(staging, directories[0]!.name)
  return fs.existsSync(path.join(inner, 'index.html')) ? inner : null
}

function readManifest(root: string): typeof manifestSchema.infer | null {
  try {
    const parsed = manifestSchema(JSON.parse(fs.readFileSync(path.join(root, META), 'utf8')))
    return parsed instanceof type.errors ? null : parsed
  }
  catch {
    return null
  }
}

function countFiles(root: string): number {
  let total = 0
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name !== META)
      total += 1
  }
  return Math.max(1, total)
}
