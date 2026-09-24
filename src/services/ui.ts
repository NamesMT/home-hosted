import type { ArchiveEntry } from '#src/providers/archive'
import type { UiMeta, UiStatus } from '#src/shared/contracts'
import fs from 'node:fs'
import path from 'node:path'
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
  async install(archivePath: string, fallbackName = 'custom-ui'): Promise<UiInstallResult> {
    if (!isZipArchive(archivePath))
      return { ok: false, error: 'the upload is not a zip archive' }

    const staging = path.join(this.options.dataRoot, `.ui-staging-${Date.now()}`)

    try {
      return await this.stage(archivePath, staging, fallbackName)
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

  private async stage(archivePath: string, staging: string, fallbackName: string): Promise<UiInstallResult> {
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
    }

    // The old UI moves aside first: renaming onto an existing directory fails.
    const previous = `${this.directory}.previous`
    fs.rmSync(previous, { recursive: true, force: true })
    if (fs.existsSync(this.directory))
      fs.renameSync(this.directory, previous)

    try {
      fs.renameSync(root, this.directory)
      writeFileAtomic(path.join(this.directory, META), `${JSON.stringify(meta, null, 2)}\n`)
    }
    catch (error) {
      fs.rmSync(this.directory, { recursive: true, force: true })
      if (fs.existsSync(previous))
        fs.renameSync(previous, this.directory)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    finally {
      fs.rmSync(previous, { recursive: true, force: true })
    }

    return { ok: true, meta }
  }
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

function readManifest(root: string): { name?: string, version?: string } | null {
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
