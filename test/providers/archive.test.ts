import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createZip, isZipArchive, listZip } from '#src/providers/archive'

/**
 * Backups are zips over a live tree someone else is editing, so the walk has to
 * tolerate a directory that goes away while it is being read.
 */

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-archive-'))
  cleanups.push(() => fs.promises.rm(dir, { recursive: true, force: true }))
  return dir
}

describe('createZip', () => {
  it('zips a tree, leaving out a directory that vanishes mid-walk', async () => {
    const root = await tempDir()
    const out = path.join(root, '..', `${path.basename(root)}.zip`)
    cleanups.push(() => fs.promises.rm(out, { force: true }))

    fs.mkdirSync(path.join(root, 'keep'), { recursive: true })
    fs.writeFileSync(path.join(root, 'keep', 'a.txt'), 'a')
    // A directory a build step is cleaning up while the backup runs. It exists for
    // the stat that classifies it, then is gone by the readdir — which used to sit
    // outside the try/catch and reject `createZip` outright.
    const doomed = path.join(root, 'doomed')
    fs.mkdirSync(doomed, { recursive: true })
    const realReaddir = fs.readdirSync
    const spy = (target: fs.PathLike, ...rest: unknown[]): string[] => {
      if (String(target) === doomed) {
        fs.rmSync(doomed, { recursive: true, force: true })
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      }
      return realReaddir(target, ...(rest as []))
    }
    const patched = spy as unknown as typeof fs.readdirSync
    fs.readdirSync = patched
    try {
      await createZip(root, out)
    }
    finally {
      fs.readdirSync = realReaddir
    }

    expect(isZipArchive(out)).toBe(true)
    const names = (await listZip(out)).map(entry => entry.name)
    expect(names).toContain('keep/a.txt')
    // The directory's own entry may be there — it was classified before it went —
    // but nothing under it was invented, and the zip is a real one.
    expect(names.some(name => name.startsWith('doomed/') && name !== 'doomed/')).toBe(false)
  })
})
