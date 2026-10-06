import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

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
})
