import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CONFIG_SCHEMA } from '#src/config/migrations'

/**
 * `migrate --dry-run` promises to write nothing, and the promise is load-bearing: it is what a person
 * runs before letting a migration touch state they cannot easily restore.
 *
 * The stamp-only path is guarded. The *applying* path was not — `copyFileSync` and `writeFileAtomic`
 * sat above the `if (dryRun) return`, which is unreachable today only because `CONFIG_SCHEMA` is 1 and
 * no migration exists yet. Adding the first migration would make it live, and `--dry-run` would then
 * write while printing "nothing was written".
 *
 * This pins the contract against the real fixture: a state directory needing a stamp, where the write
 * paths are the ones that exist now.
 */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A state directory `migrate` will act on: the layout is current, the files need stamping. */
function homeWithState(): { home: string, settings: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-migrate-'))
  dirs.push(home)
  const hh = path.join(home, '.hh')
  fs.mkdirSync(path.join(hh, 'default'), { recursive: true })
  const settings = path.join(hh, 'settings.json')
  // No `meta`, so `stampConfig` changes it — which is the stamp-only write path.
  fs.writeFileSync(settings, `${JSON.stringify({ control: { port: 4100 } }, null, 2)}\n`)
  fs.writeFileSync(path.join(hh, 'workspaces.json'), `${JSON.stringify({ workspaces: [{ id: 'default', label: 'Default' }] }, null, 2)}\n`)
  fs.writeFileSync(path.join(hh, 'default', 'servers.config.json'), `${JSON.stringify({ servers: [] }, null, 2)}\n`)
  return { home, settings }
}

function runCli(home: string, args: string[]): { status: number | null, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HHOSTED_HOME: home, HHOSTED_PROJECT: home },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * A home that needs **restamping**, not lifting: every file is already the current shape (so no
 * schema step runs and no consent is asked), but each records an older release as its author.
 *
 * That is exactly what a 0.9.x home looks like beside 0.11.0 — `CONFIG_SCHEMA` did not move between
 * them, so upgrading rewrites `meta.writtenBy` on every file and nothing else. Measured: three files
 * restamped, and `--dry-run` used to mention none of them.
 */
function homeNeedingRestamp(): { home: string, settings: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-migrate-restamp-'))
  dirs.push(home)
  const hh = path.join(home, '.hh')
  fs.mkdirSync(path.join(hh, 'default'), { recursive: true })
  const settings = path.join(hh, 'settings.json')
  const old = { writtenBy: '0.9.11', schema: CONFIG_SCHEMA }
  fs.writeFileSync(settings, `${JSON.stringify({ meta: old, control: { port: 4100 } }, null, 2)}\n`)
  fs.writeFileSync(path.join(hh, 'workspaces.json'), `${JSON.stringify({ workspaces: [{ id: 'default', label: 'Default' }] }, null, 2)}\n`)
  fs.writeFileSync(path.join(hh, 'default', 'settings.json'), `${JSON.stringify({ meta: old, defaults: {} }, null, 2)}\n`)
  fs.writeFileSync(path.join(hh, 'default', 'servers.config.json'), `${JSON.stringify({ meta: old, servers: [] }, null, 2)}\n`)
  return { home, settings }
}

describe('migrate --dry-run', () => {
  it('writes nothing, and says so', () => {
    const { home, settings } = homeWithState()
    const before = fs.readFileSync(settings, 'utf8')

    const result = runCli(home, ['migrate', '--dry-run'])

    expect(result.stdout).toContain('nothing was written (--dry-run)')
    expect(fs.readFileSync(settings, 'utf8'), 'the file it reported skipping').toBe(before)
    // No backup beside it either: `copyFileSync` to `.bak` is the other half of the same write path.
    expect(fs.existsSync(`${settings}.bak`), 'no backup should be made by a dry run').toBe(false)
  })

  it('does write when actually asked, so the dry run is the thing being tested', () => {
    const { home, settings } = homeWithState()
    const before = fs.readFileSync(settings, 'utf8')

    runCli(home, ['migrate', '--yes'])

    expect(fs.readFileSync(settings, 'utf8'), 'a real run stamps the file').not.toBe(before)
  })

  /**
   * The plan a person rehearses has to describe the run it plans.
   *
   * A home whose files are already the current schema but carry an older `meta.writtenBy` is
   * restamped, not lifted — and `--dry-run` said nothing at all about it, closing with a bare
   * "nothing was written (--dry-run)" while the real run rewrote every one of those files and
   * printed "3 file(s) stamped". Measured on a real 0.9.11 home: `migrate --dry-run` printed one
   * line, `migrate --yes` rewrote three files.
   */
  it('describes the restamps it would make, and counts them', () => {
    const { home } = homeNeedingRestamp()

    const result = runCli(home, ['migrate', '--dry-run'])

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout, 'the plan named no work').toContain('would be stamped')
    expect(result.stdout).toContain('stamping global settings')
    // It still says it wrote nothing — the two statements are not in conflict.
    expect(result.stdout).toContain('nothing was written (--dry-run)')
  })

  it('agrees with the real run about how many files it touches', () => {
    const dry = runCli(homeNeedingRestamp().home, ['migrate', '--dry-run'])
    const real = runCli(homeNeedingRestamp().home, ['migrate', '--yes'])

    const count = (text: string): number => Number(/(\d+) file\(s\)/.exec(text)?.[1] ?? -1)

    expect(count(dry.stdout), 'the dry run and the real run must describe the same work').toBe(3)
    expect(count(dry.stdout)).toBe(count(real.stdout))
  })

  /**
   * Every file this command rewrites leaves a `.bak`, restamps included.
   *
   * `README.md` and `.agentDocs/COMPATIBILITY.md` both promise one "beside each rewritten file", and
   * the restamp branch rewrote without keeping a copy — so a home whose files were merely restamped
   * came back with no record of what was there, while the person had been told otherwise. It is one
   * promise, so it holds on both branches.
   */
  it('keeps a .bak beside each file it restamps', () => {
    const { home, settings } = homeNeedingRestamp()
    const before = fs.readFileSync(settings, 'utf8')

    const result = runCli(home, ['migrate', '--yes'])

    expect(result.status, result.stderr).toBe(0)
    expect(fs.readFileSync(`${settings}.bak`, 'utf8'), 'the backup must be the pre-run file').toBe(before)
  })
})

/**
 * The last line is what a person reads to decide whether to run this again, so it may not say
 * "nothing to migrate" after lifting files — which it did, because only the stamp-only path was
 * counted. Measured on a real 0.7.21 home: three `migrated … to schema 2` lines, then
 * "every file is already what home-hosted 0.10.0 understands — nothing to migrate".
 */
describe('migrate summary', () => {
  /** A state directory whose three files are stamped schema 1, so all three need the 1 → 2 step. */
  function homeNeedingMigration(): { home: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-migrate-sum-'))
    dirs.push(home)
    const hh = path.join(home, '.hh')
    fs.mkdirSync(path.join(hh, 'default'), { recursive: true })
    const stamp = { writtenBy: '0.7.21', schema: 1 }
    fs.writeFileSync(path.join(hh, 'settings.json'), `${JSON.stringify({ meta: stamp, control: { port: 4100 } }, null, 2)}\n`)
    fs.writeFileSync(path.join(hh, 'workspaces.json'), `${JSON.stringify({ workspaces: [{ id: 'default', label: 'Default' }] }, null, 2)}\n`)
    fs.writeFileSync(path.join(hh, 'default', 'settings.json'), `${JSON.stringify({ meta: stamp, notifications: { telegram: { enabled: false, chatId: '' } } }, null, 2)}\n`)
    fs.writeFileSync(path.join(hh, 'default', 'servers.config.json'), `${JSON.stringify({ meta: stamp, servers: [] }, null, 2)}\n`)
    return { home }
  }

  it('counts the files it lifted, and does not claim there was nothing to migrate', () => {
    const { home } = homeNeedingMigration()

    const result = runCli(home, ['migrate', '--yes'])

    expect(result.status, result.stderr).toBe(0)
    // The contradiction this pins: it lifted files, so the closing line must not deny it.
    expect(result.stdout).not.toContain('nothing to migrate')
    expect(result.stdout).toContain('3 file(s) migrated')
  })

  it('still says so when a second run really has nothing to do', () => {
    const { home } = homeNeedingMigration()
    runCli(home, ['migrate', '--yes'])

    const second = runCli(home, ['migrate', '--yes'])

    expect(second.status, second.stderr).toBe(0)
    expect(second.stdout).toContain('nothing to migrate')
  })
})
