import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanScratch, makeHome, takeArchive } from '../support/backup-outcome'
import { runCli } from '../support/run-cli'

afterEach(cleanScratch)

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
