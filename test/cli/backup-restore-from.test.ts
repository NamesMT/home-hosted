import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanScratch, makeHome, makeZip, scratch, takeArchive } from '../support/backup-outcome'
import { runCli } from '../support/run-cli'

afterEach(cleanScratch)

/**
 * `restore --from <path>`: the archive is wherever the person put it.
 *
 * The blank-host move used to be "copy it into the backups directory first". `--from` reads that
 * one file, through the **same** gates the multipart upload route uses (`admitArchive`), and then
 * plans the restore — so a path changes where the bytes are read from, never where they may land.
 */
describe('restore --from', () => {
  it('restores from an archive outside the backups directory', () => {
    const { home } = makeHome()
    // Take it on this host, then move it off: the copy a person carries to a dead box.
    const name = takeArchive(home)
    const carried = scratch('hh-from-carry-')
    const elsewhere = path.join(carried, name)
    fs.renameSync(path.join(home, '.hh', '.backups', name), elsewhere)
    expect(fs.existsSync(path.join(home, '.hh', '.backups', name))).toBe(false)

    const result = runCli(['backup', 'restore', '--from', elsewhere, '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status, result.output).toBe(0)
    expect(result.output).toMatch(/restored \d+ items?/)
    // Named by the file it actually read, not by a name it never had.
    expect(result.output).toContain(path.basename(elsewhere))
  }, 90_000)

  it('refuses a file that is not a zip, with the same sentence the upload route gives', () => {
    const { home } = makeHome()
    const notAnArchive = path.join(scratch('hh-from-junk-'), 'archive.zip')
    fs.writeFileSync(notAnArchive, 'this is not a zip\n')

    const result = runCli(['backup', 'restore', '--from', notAnArchive, '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status, result.stderr).toBe(1)
    // The service's own wording — one implementation, so the two doors cannot drift apart.
    expect(result.output).toContain('not a home-hosted backup')
  }, 90_000)

  it('refuses an archive whose entries escape the restore allowlist', async () => {
    const { home } = makeHome()
    const escaping = path.join(scratch('hh-from-escape-'), 'escaping.zip')
    await makeZip(escaping, {
      'manifest.json': JSON.stringify({ version: 1, createdAt: Date.now(), data: [] }),
      'payload/evil.txt': 'evil\n',
    })

    const result = runCli(['backup', 'restore', '--from', escaping, '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status, result.stderr).toBe(1)
    expect(result.output).toContain('unexpected entries')
    expect(result.output).toContain('evil.txt')
  }, 60_000)

  it('names the missing file rather than calling it a bad archive', () => {
    const { home } = makeHome()
    const missing = path.join(scratch('hh-from-missing-'), 'not-here.zip')

    const result = runCli(['backup', 'restore', '--from', missing, '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status, result.stderr).toBe(1)
    // "not a home-hosted backup" would send someone to inspect an archive that is simply absent.
    expect(result.output).toContain('no file at')
    expect(result.output).not.toContain('not a home-hosted backup')
  }, 60_000)

  it('refuses a name and --from together rather than picking one', () => {
    const { home } = makeHome()
    const name = takeArchive(home)

    const result = runCli(['backup', 'restore', name, '--from', path.join(home, '.hh', '.backups', name), '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status, result.stderr).toBe(1)
    // On the one command that overwrites live data, choosing between two named archives is a guess.
    expect(result.output).toContain('not both')
  }, 90_000)

  it('leaves the name-only path exactly as it was', () => {
    const { home } = makeHome()
    const name = takeArchive(home)

    const result = runCli(['backup', 'restore', name, '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status, result.output).toBe(0)
    expect(result.output).toMatch(/restored \d+ items?/)
    expect(result.output).toContain(name)
  }, 90_000)
})
