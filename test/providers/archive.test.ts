import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createZip, extractZip, isInvalidPassword, isZipArchive, listZip } from '#src/providers/archive'

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

/**
 * The one thing that decides whether a person is told "the password is wrong".
 *
 * `isInvalidPassword` is a case-insensitive substring match, so it is worth pinning what the real
 * extraction path actually produces — these strings were read off zip.js rather than guessed. The
 * check being coarse was worth testing in both directions: a *false positive* would tell someone
 * their password is wrong when the archive is simply unreadable, and the two messages below are the
 * ones that could plausibly carry the word without meaning it.
 */
describe('telling a wrong password from an unreadable archive', () => {
  it('recognises the rejection zip.js raises for a bad password', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-pw-'))
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'secret\n')
      const zip = path.join(dir, 'out.zip')
      await createZip(path.join(dir, 'src'), zip, { password: 'right' })

      let thrown: unknown
      try {
        await extractZip(zip, path.join(dir, 'out'), { names: ['a.txt'], password: 'wrong' })
      }
      catch (error) {
        thrown = error
      }
      expect(thrown, 'a wrong password must throw').toBeDefined()
      expect(isInvalidPassword(thrown), `recognised from: ${(thrown as Error).message}`).toBe(true)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not mistake an unreadable archive for a wrong password', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-pw-'))
    try {
      // A path that does not exist — zip.js reports this without naming the file, so the message
      // never carries the word "password" even when the filename does. Verified, not assumed: a
      // message like `ENOENT: /x/my-password.zip` would have made this check misfire.
      const missing = path.join(dir, 'my-password-backup.zip')
      let thrown: unknown
      try {
        await extractZip(missing, path.join(dir, 'out'), { names: ['global/settings.json'] })
      }
      catch (error) {
        thrown = error
      }
      expect(thrown, 'a missing archive must throw').toBeDefined()
      expect(isInvalidPassword(thrown), `must not read as a wrong password: ${(thrown as Error).message}`).toBe(false)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
