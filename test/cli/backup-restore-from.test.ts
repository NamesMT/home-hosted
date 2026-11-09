import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanScratch, makeHome, makeZip, scratch, takeArchive, writeDumpingWorkspace } from '../support/backup-outcome'
import { runCli } from '../support/run-cli'

afterEach(cleanScratch)

/**
 * A blank host, a dead box, one archive carried over on a USB stick — and a name-versus-path mistake.
 *
 * `restore` takes the archive's **file name** inside the backups directory and refuses a path, by
 * design: the name is an allowlist entry, and a restore writes over live data. But the refusal used
 * to say only *"no backup named … — `backup list` shows them"*, and on a genuinely blank host that
 * command answers *"no backups yet"*. Two dead ends in a row, for the person with the single most
 * common disaster-recovery move in their hands.
 */
describe('a restore that names a file path', () => {
  it('says which directory the name belongs to, that a path is not a name, and which flag takes one', () => {
    const { home, backups } = makeHome()
    const name = takeArchive(home)
    const elsewhere = scratch('hh-outcome-carry-')
    fs.copyFileSync(path.join(backups, name), path.join(elsewhere, name))

    const result = runCli(['backup', 'restore', path.join(elsewhere, name), '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status).toBe(1)
    // The directory the name has to be in, and the fact that a path is not one.
    expect(result.output).toContain('.backups')
    expect(result.output).toContain('not a path')
    // And the flag that does take one, or the refusal is a dead end on a blank host.
    expect(result.output).toContain('--from')
  }, 90_000)
})

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
    expect(result.status).toBe(1)
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
    expect(result.status).toBe(1)
    expect(result.output).toContain('unexpected entries')
    expect(result.output).toContain('evil.txt')
  }, 60_000)

  it('names the missing file rather than calling it a bad archive', () => {
    const { home } = makeHome()
    const missing = path.join(scratch('hh-from-missing-'), 'not-here.zip')

    const result = runCli(['backup', 'restore', '--from', missing, '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status).toBe(1)
    // "not a home-hosted backup" would send someone to inspect an archive that is simply absent.
    expect(result.output).toContain('no file at')
    expect(result.output).not.toContain('not a home-hosted backup')
  }, 60_000)

  it('refuses a name and --from together rather than picking one', () => {
    const { home } = makeHome()
    const name = takeArchive(home)

    const result = runCli(['backup', 'restore', name, '--from', path.join(home, '.hh', '.backups', name), '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status).toBe(1)
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

/**
 * The notes a restore prints after an apply are the **apply's**, not the dry run's.
 *
 * The plan is asked for first and the apply afterwards, and the two answer different skip lists: a
 * dump whose entry carries no `load` hook is only discovered once the files have landed. The CLI
 * kept the plan's list, so that sentence — and the `skipped` array the JSON promises — said nothing
 * about a dump the archive carried but nothing will replay.
 *
 * Measured on a restored home whose entry had a `dump` hook and no `load` hook:
 *
 *     $ home-hosted backup restore <name> --all --confirm
 *     restored 7 items from <name>            # the dump was in `applied`, and was never loaded
 *     $ ... --json | jq .skipped
 *     []
 */
describe('the notes after an apply', () => {
  it('names a dump the archive carried but no entry will load', () => {
    const { home } = makeHome()
    writeDumpingWorkspace(home)

    const name = takeArchive(home)

    const result = runCli(['backup', 'restore', name, '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status, result.output).toBe(0)
    // The skip the *apply* found, in the words the service gave it.
    expect(result.output).toContain('no load hook')
  }, 90_000)

  it('carries it in the `skipped` array a script reads', () => {
    const { home } = makeHome()
    writeDumpingWorkspace(home)

    const name = takeArchive(home)

    const result = runCli(['backup', 'restore', name, '--all', '--confirm', '--json'], { home, env: { NO_COLOR: '1' } })
    expect(result.status, result.output).toBe(0)
    const body = JSON.parse(result.stdout) as { apply: boolean, skipped: string[] }
    expect(body.apply).toBe(true)
    expect(body.skipped.join('\n')).toContain('no load hook')
  }, 90_000)
})
