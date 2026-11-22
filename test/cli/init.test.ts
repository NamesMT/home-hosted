import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { detectPackageManager, scaffold } from '#src/services/init'

/**
 * `init` writes a project, a `package.json`, a `.gitignore` and (when git is present) a repository. None of
 * it was covered — the only tests that mentioned "init" were matching the word "initialised".
 *
 * The `.gitignore` is the part worth testing rather than the file list: `pnpm dev` writes state under
 * `state/.hh/`, and getting the rules wrong either commits the panel's secrets or drops the workspace
 * configs a person means to track. Both are quiet failures — the first is a leak nobody notices until it is
 * pushed, the second a config that vanishes on a fresh clone.
 */
const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch)
    fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-init-'))
  scratch.push(dir)
  return dir
}

describe('init scaffolds a project', () => {
  it('writes a manifest and a gitignore, and reports both', () => {
    const dir = path.join(tempDir(), 'proj')
    const result = scaffold({ dir, name: 'demo', pm: 'pnpm' } as never)

    expect(result.created).toBe(true)
    expect(result.files).toEqual(['package.json', '.gitignore'])
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    expect(manifest.name).toBe('demo')
    // Every script carries the project-local state directory, or `pnpm up` would drive the user's default home.
    for (const [script, command] of Object.entries(manifest.scripts) as Array<[string, string]>)
      expect(command, script).toContain('--home ./state')
    expect(manifest.dependencies['home-hosted']).toBeDefined()
  })

  /**
   * The rules that matter, asserted by **path shape** rather than by copying the file: state is local, the
   * definitions are tracked, and the secrets and data are not.
   */
  it('ignores secrets and data while tracking the workspace definitions', () => {
    const dir = path.join(tempDir(), 'proj')
    scaffold({ dir, name: 'demo', pm: 'pnpm' } as never)
    const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')

    expect(ignore, 'the secrets and the live run record must never be committed').toMatch(/state\/\.hh\/\*/)
    expect(ignore, 'the configs a person means to track must survive a clone').toContain('!state/.hh/settings.json')
    expect(ignore, 'a workspace\'s servers are config too').toContain('!state/.hh/*/servers.config.json')
    expect(ignore, 'data directories are not config').toContain('data/')
  })

  it('refuses a directory that already holds something', () => {
    const busy = tempDir()
    fs.writeFileSync(path.join(busy, 'already-here.txt'), 'x')
    expect(() => scaffold({ dir: busy, name: 'demo', pm: 'pnpm' } as never)).toThrow(/not empty/)
    // And it leaves what was there alone.
    expect(fs.readFileSync(path.join(busy, 'already-here.txt'), 'utf8')).toBe('x')
  })

  it('refuses a path that is a file', () => {
    const file = path.join(tempDir(), 'a-file')
    fs.writeFileSync(file, 'x')
    expect(() => scaffold({ dir: file, name: 'demo', pm: 'pnpm' } as never)).toThrow(/not a directory/)
  })

  /** The detected manager must be one this build can actually run, whatever the machine has. */
  it('always answers a package manager it supports', () => {
    expect(detectPackageManager(() => true)).toBe('pnpm')
    expect(detectPackageManager(command => command === 'bun')).toBe('bun')
    expect(detectPackageManager(() => false), 'a machine with none still gets a usable answer').toBe('npm')
  })
})
