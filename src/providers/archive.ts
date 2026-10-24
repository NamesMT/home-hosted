import type { FileEntry } from '@zip.js/zip.js'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Readable, Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { BlobReader, configure, ZipReader, ZipWriter } from '@zip.js/zip.js'

/**
 * `Readable.toWeb` is typed against `node:stream/web`, while zip.js declares the
 * global `ReadableStream` — the same objects under two declarations, and which
 * one wins depends on the tsconfig (the SPA's adds lib.dom). These aliases take
 * the type zip.js expects, whichever it is where this file is compiled.
 */
type ZipInput = Parameters<ZipWriter<unknown>['add']>[1]
type ZipOutput = ConstructorParameters<typeof ZipWriter>[0] & { abort: (reason?: unknown) => Promise<void> }
type ZipDataOutput = Parameters<FileEntry['getData']>[0]

/**
 * Backups are ordinary zip files: the same container whether or not they are
 * password-protected, openable by any archive manager (including the one built
 * into Windows and macOS), and produced without a native binary — zip.js is pure
 * JavaScript.
 *
 * A password means WinZip AES-256 (`encryptionStrength: 3`, AE-2): strong, and
 * still standard, unlike the legacy ZipCrypto encryption.
 */

// Deterministic, in-process codecs: a bundled CLI has no worker file to load.
configure({ useWebWorkers: false })

const ZIPS = [
  [0x50, 0x4B, 0x03, 0x04],
  [0x50, 0x4B, 0x05, 0x06],
  [0x50, 0x4B, 0x07, 0x08],
]

/** Recognised by content, never by the file's name. */
export function isZipArchive(file: string): boolean {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(4)
    const read = fs.readSync(fd, head, 0, 4, 0)
    return read === 4 && ZIPS.some(magic => magic.every((byte, index) => head[index] === byte))
  }
  catch {
    return false
  }
  finally {
    if (fd !== null)
      fs.closeSync(fd)
  }
}

export interface ArchiveEntry {
  /** Forward-slash path inside the archive; directories end with `/`. */
  name: string
  directory: boolean
  encrypted: boolean
  symlink: boolean
  /** Uncompressed size, for callers that cap what they will extract. */
  size: number
  /** The Unix mode the entry carries, when the archive recorded one. */
  mode?: number
}

/** The central directory is not encrypted, so this works without a password. */
export async function listZip(file: string): Promise<ArchiveEntry[]> {
  const reader = await open(file)
  try {
    const entries = await reader.getEntries()
    return entries.map(entry => ({
      name: entry.filename,
      directory: entry.directory === true,
      encrypted: entry.encrypted === true,
      symlink: entry.symlink === true,
      size: entry.uncompressedSize ?? 0,
      ...(entry.unixMode === undefined ? {} : { mode: entry.unixMode }),
    }))
  }
  finally {
    await reader.close()
  }
}

/**
 * True when the archive rejected the password we used.
 *
 * Matched on the wording zip.js raises for a bad password, not on the word alone: the message is
 * `Invalid password`, while a *file it cannot open* produces `ENOENT: … stat '/tmp/…/my-password-
 * backup.zip'` — which carries the word because the caller named the archive that. A substring test
 * read that as a wrong password and told the person to re-enter one, when the archive was simply
 * not there. (Caught by CI, where Node's fs message names the path; the local run said
 * `Unable to open file as blob`, so the same call looked fine.)
 */
export function isInvalidPassword(error: unknown): boolean {
  return error instanceof Error && /invalid password/i.test(error.message)
}

/**
 * Writes the contents of `sourceDir` into `destination`, preserving the tree and each
 * entry's permission bits.
 *
 * The mode is captured because the tree is somebody's data directory: a `0600` key, a `0700`
 * directory and a `0755` script are all routine there, and a backup that restores them as `0644`
 * changes who can read the data it was taken to protect. What a symlink may bring in is bounded by
 * the tree itself (`walk`): the target has to be inside it, so a declared path cannot capture bytes
 * from outside itself. Streams from disk to disk: nothing is buffered whole.
 */
export async function createZip(sourceDir: string, destination: string, options: { password?: string } = {}): Promise<void> {
  const output = fs.createWriteStream(destination, { mode: 0o600 })
  // Attached up front: the fd closes as part of the web stream ending, so a
  // listener added afterwards would wait forever.
  const flushed = finished(output)
  const writer = Writable.toWeb(output) as unknown as ZipOutput
  const zip = new ZipWriter(writer, {
    ...(options.password === undefined ? {} : { password: options.password, encryptionStrength: 3 as const }),
    level: 6,
    keepOrder: true,
  })

  try {
    for (const item of walk(sourceDir)) {
      const mode = item.mode === null ? {} : { unixMode: item.mode }
      if (item.directory)
        await zip.add(item.name, null, { directory: true, ...mode })
      else if (item.size === 0)
        // An empty file carries no content to protect, and leaving it as a plain
        // AE-2 entry makes older tools (p7zip 16.02) report a CRC failure on it.
        await zip.add(item.name, null, { directory: false, ...mode })
      else
        await zip.add(item.name, Readable.toWeb(fs.createReadStream(item.absolute)) as unknown as ZipInput, mode)
    }
    await zip.close()
    await flushed
  }
  catch (error) {
    await writer.abort(error).catch(() => {})
    // The file stream also fails here (a full disk, a directory in the way), and
    // an unobserved rejection would take the whole control plane down.
    await flushed.catch(() => {})
    throw error
  }
}

/**
 * Extracts the given entries (already validated by the caller) into
 * `destination`. Symbolic links are never recreated — an archive is not allowed
 * to make the filesystem point somewhere else.
 *
 * An entry's permission bits are applied after it lands. The file is created under a restrictive
 * mode first, so a `0600` secret never exists world-readable between two calls, and a mode the
 * current umask would widen is set with an explicit `chmod` rather than left to the create.
 */
export async function extractZip(
  file: string,
  destination: string,
  options: { names: string[], password?: string },
): Promise<{ skipped: string[] }> {
  const reader = await open(file, options.password)
  const skipped: string[] = []
  /** Directory modes, applied after their contents: a `0700` dir cannot be written into. */
  const pendingDirModes: Array<{ target: string, mode: number }> = []

  try {
    const entries = new Map((await reader.getEntries()).map(entry => [entry.filename, entry]))

    for (const name of options.names) {
      const entry = entries.get(name)
      if (entry === undefined) {
        skipped.push(name)
        continue
      }

      const target = path.join(destination, name)
      if (entry.directory) {
        fs.mkdirSync(target, { recursive: true })
        // A directory's mode is applied after the files under it are written, otherwise it would
        // close itself to the writes that have not happened yet. `mkdir` gives it the umask's
        // mode; this is the one the archive carried.
        const mode = permissionBits(entry.unixMode)
        if (mode !== null)
          pendingDirModes.push({ target, mode })
        continue
      }
      if (entry.symlink) {
        skipped.push(name)
        continue
      }

      fs.mkdirSync(path.dirname(target), { recursive: true })
      await entry.getData(Writable.toWeb(fs.createWriteStream(target, { mode: 0o600 })) as unknown as ZipDataOutput, writeOptions(entry, options.password))
      const mode = permissionBits(entry.unixMode)
      if (mode !== null) {
        try {
          fs.chmodSync(target, mode)
        }
        catch {
          // A filesystem without POSIX modes (a mounted FAT drive, a Windows share) keeps the file
          // it wrote — refusing the whole restore over metadata would lose the data to save the bit.
        }
      }
    }
  }
  finally {
    await reader.close()
    // Deepest first, so a `0700` parent cannot lock out a child that has not been chmodded yet.
    for (const { target, mode } of pendingDirModes.sort((left, right) => right.target.length - left.target.length)) {
      try {
        fs.chmodSync(target, mode)
      }
      catch {}
    }
    pendingDirModes.length = 0
  }

  return { skipped }
}

function writeOptions(entry: FileEntry, password: string | undefined): { password?: string } {
  return entry.encrypted && password !== undefined ? { password } : {}
}

async function open(file: string, password?: string): Promise<ZipReader<unknown>> {
  // A lazily-read Blob keeps a multi-gigabyte archive out of memory: zip.js only
  // pulls the byte ranges it needs.
  const blob = await fs.openAsBlob(file, { type: 'application/zip' })
  return password === undefined
    ? new ZipReader(new BlobReader(blob))
    : new ZipReader(new BlobReader(blob), { password })
}

interface WalkedFile {
  name: string
  absolute: string
  directory: boolean
  size: number
  /** The permission bits to write into the archive, or `null` where the platform has none. */
  mode: number | null
}

/**
 * The `st_mode` an entry should carry, or `null` where the platform does not report one.
 *
 * Only the permission bits and the file type are kept: the archive records a mode, not an owner,
 * because a restore runs as whoever restores it and a foreign uid would be a worse lie than the
 * restoring user's own.
 */
function archiveMode(stats: fs.Stats): number | null {
  const bits = stats.mode & 0o777
  if (process.platform === 'win32' || bits === 0)
    return null
  return (stats.isDirectory() ? 0o040000 : 0o100000) | bits
}

/**
 * The permission bits an extracted entry should be given, or `null` when the archive carries none.
 *
 * Zip stores the type in the same field, so the file type is dropped: the entry is written as the
 * ordinary file or directory this call is creating, never as a fifo or a device node an archive
 * could name. The setuid/setgid/sticky bits are dropped too — an archive from another host does not
 * get to install a privileged binary here.
 */
function permissionBits(unixMode: number | undefined): number | null {
  if (unixMode === undefined || unixMode === 0)
    return null
  const bits = unixMode & 0o777
  return bits === 0 ? null : bits
}

/** True when `child` is `parent` itself or lives underneath it, after resolving both. */
function isUnderResolved(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!path.isAbsolute(relative) && !relative.startsWith('..'))
}

/**
 * Sorted, deterministic walk with directory loops broken and the declared tree respected.
 *
 * Every read is best-effort: a directory that vanishes mid-walk (a rotated log, a
 * build directory being cleaned, a container being torn down) must leave it out of
 * the archive rather than reject `createZip` and turn a backup into a failure.
 *
 * A link that resolves **outside** `root` is left out rather than followed. `root` is a copy of the
 * declared path, so a link inside it points back at the live tree — following one captured bytes
 * from outside the path the person declared (a `media -> /mnt/nas` symlink pulled the whole share
 * into the archive), and it captured the *live* copy of anything the copy had already frozen. A
 * restore never recreates links anyway, so the link itself has nothing to restore; its content, if
 * it is wanted, is declared as its own path.
 */
function walk(root: string): WalkedFile[] {
  const files: WalkedFile[] = []
  const seen = new Set<string>()
  let realRoot: string
  try {
    realRoot = fs.realpathSync(root)
  }
  catch {
    return files
  }

  const readDir = (absolute: string): string[] => {
    try {
      return fs.readdirSync(absolute).sort()
    }
    catch {
      return []
    }
  }

  const visit = (absolute: string, name: string): void => {
    let stats: fs.Stats
    try {
      stats = fs.statSync(absolute)
    }
    catch {
      return
    }

    let real: string
    try {
      real = fs.realpathSync(absolute)
    }
    catch {
      // A link whose target went away; there is nothing to capture.
      return
    }
    if (!isUnderResolved(realRoot, real))
      return

    if (stats.isDirectory()) {
      if (seen.has(real))
        return
      seen.add(real)
      files.push({ name: `${name}/`, absolute, directory: true, size: 0, mode: archiveMode(stats) })
      for (const child of readDir(absolute))
        visit(path.join(absolute, child), `${name}/${child}`)
      return
    }

    if (stats.isFile())
      files.push({ name, absolute, directory: false, size: stats.size, mode: archiveMode(stats) })
  }

  for (const child of readDir(root))
    visit(path.join(root, child), child)

  return files
}
