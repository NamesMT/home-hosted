import type { FileEntry } from '@zip.js/zip.js'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
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
    }))
  }
  finally {
    await reader.close()
  }
}

/** True when the archive rejected the password we used. */
export function isInvalidPassword(error: unknown): boolean {
  return error instanceof Error && /password/i.test(error.message)
}

/**
 * Writes the contents of `sourceDir` into `destination`, preserving the tree.
 * Symlinks are followed, so a link to a directory is captured as a directory and
 * a link loop cannot recurse forever. Streams from disk to disk: nothing is
 * buffered whole.
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
      if (item.directory)
        await zip.add(item.name, null, { directory: true })
      else if (item.size === 0)
        // An empty file carries no content to protect, and leaving it as a plain
        // AE-2 entry makes older tools (p7zip 16.02) report a CRC failure on it.
        await zip.add(item.name, null, { directory: false })
      else
        await zip.add(item.name, Readable.toWeb(fs.createReadStream(item.absolute)) as unknown as ZipInput)
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
 */
export async function extractZip(
  file: string,
  destination: string,
  options: { names: string[], password?: string },
): Promise<{ skipped: string[] }> {
  const reader = await open(file, options.password)
  const skipped: string[] = []

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
        continue
      }
      if (entry.symlink) {
        skipped.push(name)
        continue
      }

      fs.mkdirSync(path.dirname(target), { recursive: true })
      await entry.getData(Writable.toWeb(fs.createWriteStream(target)) as unknown as ZipDataOutput, writeOptions(entry, options.password))
    }
  }
  finally {
    await reader.close()
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
}

/** Sorted, deterministic walk with symlinks resolved and directory loops broken. */
function walk(root: string): WalkedFile[] {
  const files: WalkedFile[] = []
  const seen = new Set<string>()

  const visit = (absolute: string, name: string): void => {
    let stats: fs.Stats
    try {
      stats = fs.statSync(absolute)
    }
    catch {
      return
    }

    if (stats.isDirectory()) {
      const real = fs.realpathSync(absolute)
      if (seen.has(real))
        return
      seen.add(real)
      files.push({ name: `${name}/`, absolute, directory: true, size: 0 })
      for (const child of fs.readdirSync(absolute).sort())
        visit(path.join(absolute, child), `${name}/${child}`)
      return
    }

    if (stats.isFile())
      files.push({ name, absolute, directory: false, size: stats.size })
  }

  for (const child of fs.readdirSync(root).sort())
    visit(path.join(root, child), child)

  return files
}
