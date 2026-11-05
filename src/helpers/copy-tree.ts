import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import { DetailedError } from '@namesmt/utils'

/** How long a tree operation may hold the event loop before the panel gets a turn. */
const SLICE_MS = 10

/**
 * A checkpoint that yields to the event loop once `SLICE_MS` of synchronous work has passed.
 *
 * Sync calls in slices, not `fs.promises`: every async call is a thread-pool round trip, which made a
 * tree of small files 10-20x slower to copy and walk than the sync calls it replaced.
 */
export function eventLoopSlicer(): () => Promise<void> {
  let since = performance.now()
  return async () => {
    if (performance.now() - since < SLICE_MS)
      return
    await setImmediate()
    since = performance.now()
  }
}

/**
 * `fs.cpSync(source, target, { recursive: true, force: true, filter })`, yielding between entries.
 *
 * Every non-directory entry is still copied by `cpSync`, so links, modes and special files behave as
 * they did; only the directory recursion is here, in cp's order — a directory this call creates gets
 * its source mode after its contents are written.
 */
export async function copyTree(source: string, target: string, filter: (source: string, target: string) => boolean): Promise<void> {
  const slice = eventLoopSlicer()
  const visit = async (from: string, to: string): Promise<void> => {
    if (!filter(from, to))
      return
    await slice()
    const stats = fs.lstatSync(from)
    if (!stats.isDirectory()) {
      // `recursive` as before: a link to a directory is still copied as the link.
      fs.cpSync(from, to, { recursive: true, force: true })
      return
    }
    const existing = fs.lstatSync(to, { throwIfNoEntry: false })
    if (existing !== undefined && !existing.isDirectory())
      throw new DetailedError(`cannot overwrite non-directory ${to} with directory ${from}`, { code: 'ERR_FS_CP_DIR_TO_NON_DIR' })
    if (existing === undefined)
      fs.mkdirSync(to)
    for (const name of fs.readdirSync(from))
      await visit(path.join(from, name), path.join(to, name))
    if (existing === undefined)
      fs.chmodSync(to, stats.mode)
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  await visit(source, target)
}
