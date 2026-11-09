import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanScratch, makeHome, rewriteArchive, takeArchive } from '../support/backup-outcome'
import { runCli } from '../support/run-cli'

afterEach(cleanScratch)

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

describe('a restore that applied nothing', () => {
  it('fails, and names the reason, when the archive is not a backup', () => {
    const { home, backups } = makeHome()
    fs.writeFileSync(path.join(backups, 'fake.zip'), 'not a zip at all\n')

    const result = runCli(['backup', 'restore', 'fake.zip', '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    // The service's own words; the CLI must not swallow them and exit 0.
    expect(result.status, result.stderr).toBe(1)
    expect(result.output).toContain('not a home-hosted backup')
  }, 60_000)

  it('fails, and names the schema, when the archive came from a newer release', async () => {
    const { home } = makeHome()
    const name = takeArchive(home)

    await rewriteArchive(path.join(home, '.hh', '.backups', name), 'manifest.json', `${JSON.stringify({ version: 1, createdAt: Date.now(), writtenBy: '9.9.9', schema: 99 }, null, 2)}\n`)

    const result = runCli(['backup', 'restore', name, '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(result.status, result.stderr).toBe(1)
    expect(result.output).toContain('config schema 99')
  }, 90_000)

  it('fails, and names --password, when an encrypted archive has no password', () => {
    const { home, backups } = makeHome()
    const created = runCli(['backup', 'create', '--all', '--password', 'hunter2', '--confirm'], { home, env: { NO_COLOR: '1' } })
    expect(created.status, created.output).toBe(0)
    const name = fs.readdirSync(backups).find(entry => entry.endsWith('.zip'))!

    const result = runCli(['backup', 'restore', name, '--all', '--confirm'], { home, env: { NO_COLOR: '1' } })
    // A missing password is a prompt, not a silent success.
    expect(result.status, result.stderr).toBe(1)
    expect(result.output).toContain('--password')
  }, 90_000)
})
