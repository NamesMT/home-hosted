import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export interface WriteFileOptions {
  /** Applied to the temp file before the rename, so secrets never exist world-readable. */
  mode?: number
}

/**
 * Write via a temp file in the same directory, then rename: readers never see a
 * half-written file, and a crash cannot truncate the previous config.
 */
export function writeFileAtomic(file: string, content: string, options: WriteFileOptions = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Unique per call, not just per process: two writes to the same file in one
  // process would otherwise share a temp name and the second rename would fail.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, content, options.mode === undefined ? undefined : { mode: options.mode })
    if (options.mode !== undefined)
      fs.chmodSync(tmp, options.mode)
    fs.renameSync(tmp, file)
  }
  catch (error) {
    // The temp name is unique per call, so a failed write would otherwise litter the
    // directory with a file nothing will ever reuse.
    fs.rmSync(tmp, { force: true })
    throw error
  }
}
