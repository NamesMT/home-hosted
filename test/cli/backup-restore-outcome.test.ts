import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createZip, extractZip, listZip } from '#src/providers/archive'
import { runCli } from '../support/run-cli'

/**
 * A restore that writes nothing must not read as a restore that worked.
 *
 * `runBackupRestore` filtered the plan down to the items marked selected and reported
 * "restored 0 items", but it never read `plan.error` — the field the service fills for an
 * archive that is not a backup, one whose config schema this release cannot read, or one whose
 * password is missing or wrong. Measured on a real home:
 *
 *     $ home-hosted backup restore fake.zip --all --confirm
 *     Plan for fake.zip — nothing has been written yet
 *       (nothing to restore — check --include, or what this host declares)
 *     $ echo $?
 *     0
 *
 * So the one command a person runs at 3am, on a fresh machine, exited success while the archive was
 * never applied — and `--json` said `{"apply": true, "items": []}`, which a script reads as a clean,
 * empty restore. The online path had the same hole: the local control channel answers the plan
 * verbatim with `error` riding along, and the CLI dropped it.
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Builds a zip by hand, for the entries a real archive can never carry. */
async function makeZip(file: string, entries: Record<string, string>): Promise<void> {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  for (const [name, content] of Object.entries(entries))
    await writer.add(name, new Uint8ArrayReader(Buffer.from(content)))
  fs.writeFileSync(file, await writer.close())
}

/** A home the CLI can act on, with the `.backups` directory a person drops an archive into. */
function makeHome(): { home: string, backups: string } {
  const home = scratch('hh-outcome-')
  const backups = path.join(home, '.hh', '.backups')
  fs.mkdirSync(backups, { recursive: true })
  return { home, backups }
}

/** A real archive taken on this home — the shape a valid DR archive has. */
function takeArchive(home: string): string {
  const created = runCli(['backup', 'create', '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
  expect(created.status, created.output).toBe(0)
  const name = fs.readdirSync(path.join(home, '.hh', '.backups')).find(entry => entry.endsWith('.zip'))
  expect(name).toBeDefined()
  return name!
}

/**
 * Rewrite one file inside an archive, through the same provider the service uses.
 *
 * Reached only by this test: nothing in the product rewrites an archive, and no real archive can
 * carry a manifest from a release that has not shipped yet.
 */
async function rewriteArchive(archivePath: string, file: string, contents: string): Promise<void> {
  const work = scratch('hh-outcome-rewrite-')
  const entries = await listZip(archivePath)
  await extractZip(archivePath, work, { names: entries.map(entry => entry.name) })
  fs.writeFileSync(path.join(work, file), contents)
  fs.rmSync(archivePath)
  await createZip(work, archivePath)
}

describe('a restore that applied nothing', () => {
  it('fails, and names the reason, when the archive is not a backup', () => {
    const { home, backups } = makeHome()
    fs.writeFileSync(path.join(backups, 'fake.zip'), 'not a zip at all\n')

    const result = runCli(['backup', 'restore', 'fake.zip', '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    // The service's own words; the CLI must not swallow them and exit 0.
    expect(result.status).toBe(1)
    expect(result.output).toContain('not a home-hosted backup')
  }, 60_000)

  it('fails, and names the schema, when the archive came from a newer release', async () => {
    const { home } = makeHome()
    const name = takeArchive(home)

    await rewriteArchive(path.join(home, '.hh', '.backups', name), 'manifest.json', `${JSON.stringify({ version: 1, createdAt: Date.now(), writtenBy: '9.9.9', schema: 99 }, null, 2)}\n`)

    const result = runCli(['backup', 'restore', name, '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status).toBe(1)
    expect(result.output).toContain('config schema 99')
  }, 90_000)

  it('fails, and names --password, when an encrypted archive has no password', () => {
    const { home, backups } = makeHome()
    const created = runCli(['backup', 'create', '--all', '--password', 'hunter2', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(created.status, created.output).toBe(0)
    const name = fs.readdirSync(backups).find(entry => entry.endsWith('.zip'))!

    const result = runCli(['backup', 'restore', name, '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    // A missing password is a prompt, not a silent success.
    expect(result.status).toBe(1)
    expect(result.output).toContain('--password')
  }, 90_000)

  it('fails, and names --password, when the password is wrong', () => {
    const { home, backups } = makeHome()
    const created = runCli(['backup', 'create', '--all', '--password', 'hunter2', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(created.status, created.output).toBe(0)
    const name = fs.readdirSync(backups).find(entry => entry.endsWith('.zip'))!

    const result = runCli(['backup', 'restore', name, '--all', '--password', 'wrong', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status).toBe(1)
    expect(result.output).toContain('--password')
  }, 90_000)

  it('reports an applied restore honestly, and keeps exiting 0', () => {
    const { home } = makeHome()
    const name = takeArchive(home)

    const result = runCli(['backup', 'restore', name, '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status, result.output).toBe(0)
    expect(result.output).toMatch(/restored \d+ items?/)
  }, 90_000)
})

/**
 * A restore that applied *some* of an archive must say which pieces it left behind.
 *
 * The service puts each one in `skipped` — an unreadable `servers.config.json`, a data path whose
 * declaration this host no longer has — and the UI draws that list. The CLI printed only the applied
 * count, so a restore that lost every server definition, and the data that belonged to it, said
 * "restored 5 items" and nothing else. On a disaster-recovery run that is the difference between
 * "my stack is back" and "my stack has no servers and its data is gone".
 */
describe('a restore that applied only part of an archive', () => {
  it('names each piece it had to leave behind', async () => {
    const { home } = makeHome()
    const name = takeArchive(home)
    // An archive whose servers file this release cannot read: everything else applies, that leaf
    // is skipped.
    await rewriteArchive(path.join(home, '.hh', '.backups', name), 'workspaces/default/servers.config.json', '{"not": "a servers file"}\n')

    const result = runCli(['backup', 'restore', name, '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status, result.output).toBe(0)
    expect(result.output).toMatch(/restored \d+ items?/)
    expect(result.output).toContain('!')
    expect(result.output).toContain('Servers')
  }, 90_000)
})

/**
 * A mistyped `--exclude` on a restore is the most expensive typo in the product.
 *
 * `create` refused one (`assertKnown`), `restore` did not — so the id was ignored by the service and
 * the archive applied *everything*, including the credentials the person believed they had just
 * left out. Measured on a real home: a target panel whose password was its own, restored with
 * `--exclude globalsecrets` (one character group short of `global:secrets`), ended up carrying the
 * password hash of the source machine:
 *
 *     before: {"salt":"04qWjSR35cNg9sWjjPumLw==",…}
 *     after:  {"salt":"DUzrN/vMIH3I3RbD1eVPiA==",…}   <- byte-identical to the source's
 *
 * The whole point of the documented pair `--exclude global:secrets` is that a shared or moved
 * archive does not carry a machine's credentials; a typo silently undid it.
 */
describe('a mistyped id on a restore', () => {
  it('is refused, on both flags, before anything is written', () => {
    const { home } = makeHome()
    const name = takeArchive(home)

    const excluded = runCli(['backup', 'restore', name, '--all', '--exclude', 'globalsecrets', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(excluded.status).toBe(1)
    expect(excluded.output).toContain('globalsecrets')
    expect(excluded.output).toContain('not in this plan')
    // The hint must name a command that lists *this* plan's ids — the archive's, not the host's.
    expect(excluded.output).toContain('backup restore')

    const included = runCli(['backup', 'restore', name, '--include', 'workspace:ghost', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(included.status).toBe(1)
    expect(included.output).toContain('workspace:ghost')
  }, 90_000)

  it('leaves the target credential alone when the exclusion is spelled right', () => {
    const { home, backups } = makeHome()
    // A target panel with its own password, which a restore excluding the secrets must not touch.
    const own = runCli(['set-password'], { home, env: { NO_COLOR: '1', HHOSTED_PASSWORD: 'the-targets-own-password' } })
    expect(own.status, own.output).toBe(0)
    const before = fs.readFileSync(path.join(home, '.hh', '.control-secrets.json'), 'utf8')

    // Take the archive from a *second* home, so its secrets differ from this one's. It needs a
    // password of its own, or `global:secrets` would not be in the archive to leave out.
    const other = makeHome()
    const otherOwn = runCli(['set-password'], { home: other.home, env: { NO_COLOR: '1', HHOSTED_PASSWORD: 'the-other-machines-password' } })
    expect(otherOwn.status, otherOwn.output).toBe(0)
    const otherName = takeArchive(other.home)
    fs.copyFileSync(path.join(other.backups, otherName), path.join(backups, 'from-elsewhere.zip'))
    const otherSecrets = fs.readFileSync(path.join(other.home, '.hh', '.control-secrets.json'), 'utf8')
    expect(otherSecrets).not.toBe(before)

    const result = runCli(['backup', 'restore', 'from-elsewhere.zip', '--all', '--exclude', 'global:secrets', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status, result.output).toBe(0)
    // The target's own password object is exactly what it was: not replaced by the archive's.
    expect(fs.readFileSync(path.join(home, '.hh', '.control-secrets.json'), 'utf8')).toBe(before)
  }, 120_000)
})

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
