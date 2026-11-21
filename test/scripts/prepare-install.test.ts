import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * `prepare` must survive a consumer's install.
 *
 * `package.json#prepare` runs in three different situations, and the one it was written for is the
 * rarest: a contributor's `pnpm install`. It also runs for a `file:` or git dependency, where there is
 * no `.git`, no `simple-git-hooks` binary (it is a devDependency), and quite possibly no `pnpm` — and
 * there it failed with `/bin/sh: simple-git-hooks: command not found`. npm 11 hides that behind its
 * "install scripts not yet approved" warning, so a broken install of a package whose only job is to be
 * installed looked fine.
 *
 * Two things are pinned here, because both were wrong at once:
 *
 *  - the script the `prepare` entry point names must be **in the tarball** — it was not, so the shipped
 *    package pointed at `scripts/prepare.mjs` while `files` omitted `scripts/`;
 *  - running it with no `.git`, no sheets and a bare `PATH` must exit 0 rather than throw.
 */
const repo = process.cwd()
const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

/** The package's `files` list, which is what a consumer actually receives. */
function shipped(): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
  return pkg.files ?? []
}

describe('the prepare script survives a consumer install', () => {
  it('ships the file its own `prepare` entry point names', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
    const prepare = String(pkg.scripts?.prepare ?? '')
    const named = /node\s+(\S+\.mjs)/.exec(prepare)?.[1]
    expect(named, 'the prepare entry point must name a script').toBeTruthy()
    // `expect(...).toBeTruthy()` narrows nothing for the compiler; say it once.
    if (named === undefined)
      throw new Error('unreachable: asserted above')

    const files = shipped()
    const covered = files.some(entry => entry === named
      || (fs.existsSync(path.join(repo, entry)) && fs.statSync(path.join(repo, entry)).isDirectory() && named.startsWith(`${entry}/`)))
    expect(covered, `${named} is not in package.json#files, so a consumer's prepare points at nothing`).toBe(true)
  })

  it('exits 0 in a tree with no .git, no sheets and a bare PATH', () => {
    // A copy of just what the script needs: itself. Everything else it looks for is deliberately absent,
    // which is what a consumer's `node_modules/home-hosted` looks like.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-prepare-'))
    roots.push(dir)
    fs.mkdirSync(path.join(dir, 'scripts'))
    fs.copyFileSync(path.join(repo, 'scripts', 'prepare.mjs'), path.join(dir, 'scripts', 'prepare.mjs'))

    const result = spawnSync(process.execPath, [path.join(dir, 'scripts', 'prepare.mjs')], {
      cwd: dir,
      // No pnpm, no `node_modules/.bin`: exactly what broke the old one-liner.
      env: { PATH: process.platform === 'win32' ? '' : '/usr/bin:/bin', HOME: os.homedir() },
      encoding: 'utf8',
      timeout: 30_000,
    })

    expect(result.error, 'the script did not start').toBeUndefined()
    expect(
      result.status,
      `prepare must not fail a consumer install — stderr: ${(result.stderr ?? '').slice(0, 300)}`,
    ).toBe(0)
    // And it must not pretend it did work it did not: no hooks, no catalogs here.
    expect(result.stdout ?? '').not.toContain('Generated')
  })
})
