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
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content, options.mode === undefined ? undefined : { mode: options.mode })
  if (options.mode !== undefined)
    fs.chmodSync(tmp, options.mode)
  fs.renameSync(tmp, file)
}
