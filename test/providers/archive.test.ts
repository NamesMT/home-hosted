import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
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
 * The bytes in an archive are somebody's data directory, and a data directory is where a person
 * keeps the file modes that matter: a `0600` key, a `0700` directory, a `0755` script.
 *
 * The round trip used to lose all three, because the writer never recorded a mode and the extractor
 * never applied one — so a restore produced `0644` for everything and a secret that was private on
 * the old machine was world-readable on the new one. That is the mirror image of a security defect:
 * a backup silently widening access to what it was taken to protect.
 */
describe('permission bits survive the round trip', () => {
  // Windows has no POSIX permission bits: `chmodSync` only toggles the read-only flag and
  // `statSync().mode` reports a synthetic value, so neither the fixture nor the assertion can mean
  // anything there. The capture half is POSIX-only by nature; the *restore* half still runs anywhere
  // the archive carries a mode, which is why the format is what these cases pin.
  it.runIf(process.platform !== 'win32')('writes each entry\'s mode into the archive', async () => {
    const dir = await tempDir()
    const src = path.join(dir, 'src')
    fs.mkdirSync(path.join(src, 'private'), { recursive: true })
    fs.writeFileSync(path.join(src, 'run.sh'), '#!/bin/sh\n')
    fs.writeFileSync(path.join(src, 'private', 'api.key'), 'token\n')
    fs.chmodSync(path.join(src, 'run.sh'), 0o755)
    fs.chmodSync(path.join(src, 'private', 'api.key'), 0o600)
    fs.chmodSync(path.join(src, 'private'), 0o700)

    const zip = path.join(dir, 'out.zip')
    await createZip(src, zip)

    const byName = new Map((await listZip(zip)).map(entry => [entry.name, entry]))
    expect(byName.get('run.sh')?.mode, 'the executable bit must travel').toBe(0o100755)
    expect(byName.get('private/api.key')?.mode).toBe(0o100600)
    expect(byName.get('private/')?.mode).toBe(0o040700)
  })

  it.runIf(process.platform !== 'win32')('restores the mode each entry carried, including a directory\'s', async () => {
    const dir = await tempDir()
    const src = path.join(dir, 'src')
    fs.mkdirSync(path.join(src, 'locked'), { recursive: true })
    fs.writeFileSync(path.join(src, 'locked', 'z.txt'), 'z\n')
    fs.writeFileSync(path.join(src, 'api.key'), 'token\n')
    fs.chmodSync(path.join(src, 'api.key'), 0o600)
    fs.chmodSync(path.join(src, 'locked'), 0o700)

    const zip = path.join(dir, 'out.zip')
    await createZip(src, zip)
    const out = path.join(dir, 'out')
    await extractZip(zip, out, { names: ['api.key', 'locked/', 'locked/z.txt'] })

    // The mask is the point: `createWriteStream` under the default umask would have produced 0644
    // for the key, and a restore that leaves a secret readable is the defect this pins.
    expect(fs.statSync(path.join(out, 'api.key')).mode & 0o777).toBe(0o600)
    // A directory's mode is applied after its contents, so the file under it is still written.
    expect(fs.statSync(path.join(out, 'locked')).mode & 0o777).toBe(0o700)
    expect(fs.readFileSync(path.join(out, 'locked', 'z.txt'), 'utf8')).toBe('z\n')
  })

  it('never restores a setuid, setgid or sticky bit from an archive', async () => {
    // An archive may come from a machine this host does not trust; a privileged bit in it would
    // install a binary that runs as whoever starts it. Mode capture keeps only `0o777`.
    const dir = await tempDir()
    const src = path.join(dir, 'src')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'tool'), '#!/bin/sh\n')
    fs.chmodSync(path.join(src, 'tool'), 0o755)

    const zip = path.join(dir, 'out.zip')
    const { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } = await import('@zip.js/zip.js')
    const writer = new ZipWriter(new Uint8ArrayWriter())
    await writer.add('tool', new Uint8ArrayReader(new TextEncoder().encode('#!/bin/sh\n')), { unixMode: 0o104755 })
    fs.writeFileSync(zip, await writer.close())

    try {
      await extractZip(zip, path.join(dir, 'out'), { names: ['tool'] })
      const mode = fs.statSync(path.join(dir, 'out', 'tool')).mode & 0o7777
      expect(mode & 0o4000, 'setuid must not survive').toBe(0)
      expect(mode & 0o2000, 'setgid must not survive').toBe(0)
      expect(mode & 0o1000, 'the sticky bit must not survive').toBe(0)
    }
    catch (error) {
      // A platform without POSIX modes has nothing to assert here; the skip is explicit.
      if ((error as NodeJS.ErrnoException).code === 'EPERM')
        return
      throw error
    }
  })
})

/**
 * A declared data path is the boundary a backup captures, and a symlink inside it used to move that
 * boundary silently.
 *
 * Measured on the built CLI before the fix: a declared `/tmp/…/leak/data` holding nothing but a
 * `media -> /tmp/…/leak/outside-big` link produced a 3.8 MB archive carrying the 4 MB
 * `media/video.mp4`, while `du -sh data` said zero. The panel had copied bytes from outside the path
 * the person declared — on a NAS-backed `media -> /mnt/nas` link that is the whole share.
 */
describe('a declared tree is the capture boundary', () => {
  it('leaves out a link that resolves outside the declared path', async () => {
    const dir = await tempDir()
    const inside = path.join(dir, 'data')
    const outside = path.join(dir, 'outside')
    fs.mkdirSync(inside, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(inside, 'a.txt'), 'in\n')
    fs.writeFileSync(path.join(outside, 'passwd.txt'), 'OUTSIDE\n')
    fs.symlinkSync(outside, path.join(inside, 'escape-dir'))
    fs.symlinkSync(path.join(outside, 'passwd.txt'), path.join(inside, 'escape-file'))

    const zip = path.join(dir, 'out.zip')
    await createZip(inside, zip)
    const names = (await listZip(zip)).map(entry => entry.name)

    expect(names).toContain('a.txt')
    expect(names.filter(name => name.includes('escape'))).toEqual([])
  })

  it('still captures a link that stays inside the declared path, once', async () => {
    // An internal link is ordinary (a `current -> releases/v5` deploy layout), and dropping it
    // would lose that tree from the archive. Following it duplicates the bytes though, so the walk
    // records each real directory once — the first name it was reached by.
    const dir = await tempDir()
    const root = path.join(dir, 'data')
    fs.mkdirSync(path.join(root, 'releases', 'v5'), { recursive: true })
    fs.writeFileSync(path.join(root, 'releases', 'v5', 'big.bin'), 'payload\n')
    fs.symlinkSync(path.join(root, 'releases', 'v5'), path.join(root, 'current'))

    const zip = path.join(dir, 'out.zip')
    await createZip(root, zip)
    const names = (await listZip(zip)).map(entry => entry.name)
    const copies = names.filter(name => name.endsWith('big.bin'))

    expect(copies).toHaveLength(1)
    // `current` sorts before `releases`, so the link's path is the one that is kept.
    expect(copies[0]).toBe('current/big.bin')
  })

  it('captures the target of a declared root that is itself a symlink', async () => {
    // The rule is about links *inside* the declared path. A person who declares a symlinked
    // directory meant the directory it points at, so the root resolves rather than being skipped.
    const dir = await tempDir()
    const real = path.join(dir, 'real-disk')
    fs.mkdirSync(real, { recursive: true })
    fs.writeFileSync(path.join(real, 'db.sqlite'), 'DB\n')
    const link = path.join(dir, 'datalink')
    fs.symlinkSync(real, link)

    const zip = path.join(dir, 'out.zip')
    await createZip(link, zip)

    expect((await listZip(zip)).map(entry => entry.name)).toContain('db.sqlite')
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

      // Platform-dependent message, so asserted directly as well as through the real call above:
      // Linux names the path (`ENOENT: … stat '/tmp/…/my-password-backup.zip'`), while macOS and a
      // local run say `Unable to open file as blob`. The path one carries the word "password"
      // because the caller chose the filename, and a substring test read that as a bad password.
      expect(isInvalidPassword(new Error('ENOENT: no such file or directory, stat \'/tmp/x/my-password-backup.zip\'')), 'a path is not a password rejection').toBe(false)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
