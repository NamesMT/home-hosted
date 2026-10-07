import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * `bin/home-hosted.mjs` is the entry point every user actually runs — the published `bin` —
 * and nothing tested it. It picks between the built CLI and the TypeScript sources, and it
 * deliberately sets `cwd` and `HHOSTED_PROJECT` differently for each, which is exactly the
 * kind of branch that rots unnoticed: the sources path was broken from anywhere but the
 * repository root until the `#src` directory imports were given exact mappings.
 *
 * These run it the way a linked checkout and an installed copy do.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))
const bin = path.join(root, 'bin', 'home-hosted.mjs')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-bin-'))
  dirs.push(dir)
  return dir
}

/** Run the bin from `cwd`, with no `dist` when `built` is false. */
function runBin(args: string[], options: { cwd: string, built: boolean }): { status: number | null, stdout: string, stderr: string } {
  const dist = path.join(root, 'dist')
  const stash = `${dist}.bin-test-stash`
  const hadDist = fs.existsSync(dist)

  if (!options.built && hadDist) {
    fs.renameSync(dist, stash)
  }
  try {
    const result = spawnSync(process.execPath, [bin, ...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      // `HHOSTED_HOME` so nothing touches the real state directory.
      env: { ...process.env, HHOSTED_HOME: options.cwd },
      timeout: 120_000,
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }
  finally {
    if (!options.built && hadDist)
      fs.renameSync(stash, dist)
  }
}

describe('the published bin', () => {
  it('runs the built CLI from a directory that is not the repository root', () => {
    const cwd = tempDir()
    const result = runBin(['logs'], { cwd, built: true })

    expect(result.stderr, result.stderr).not.toContain('ERR_MODULE_NOT_FOUND')
    // No log yet is the ordinary answer for a fresh home, and it proves the whole chain ran.
    expect(result.stdout).toContain('no output yet')
    expect(result.status).toBe(0)
  })

  /**
   * The branch a linked checkout takes before its first build. It is the one that broke: the
   * sources path resolves `#src/...` mappings, and two of them pointed at directories, which
   * Node ESM refuses.
   *
   * `up --print-config` rather than `logs` on purpose — it loads the whole module graph
   * (`config/store` is what imported the directory) and exits without serving anything, so
   * this reaches the regression that `logs` never touched.
   */
  it('falls back to the TypeScript sources when there is no build', () => {
    const cwd = tempDir()
    const result = runBin(['up', '--print-config'], { cwd, built: false })

    expect(result.stderr, result.stderr).not.toContain('is not supported resolving ES modules')
    expect(result.stderr, result.stderr).not.toContain('ERR_MODULE_NOT_FOUND')
    // The effective config, which is only reachable once the whole graph loaded.
    expect(result.stdout).toContain('"servers"')
    expect(result.status).toBe(0)
  })

  it('runs logs through the sources fallback as well', () => {
    const cwd = tempDir()
    const result = runBin(['logs'], { cwd, built: false })

    expect(result.stderr, result.stderr).not.toContain('ERR_MODULE_NOT_FOUND')
    expect(result.stdout).toContain('no output yet')
    expect(result.status).toBe(0)
  })

  /**
   * The condition the `#src` directory imports broke, reproduced exactly.
   *
   * The bin pins `cwd: root` for the sources path, so it was never affected — but `up`
   * re-spawns the daemon with `cwd: projectDir`, and a `pnpm link`ed checkout runs its entry
   * from wherever the person is. That combination resolves `#src/...` from a foreign cwd,
   * where Node ESM refuses to resolve a specifier that names a directory.
   *
   * Detached `up`, because the daemon is the process that runs in that cwd; the panel's own
   * log is where a failure to load lands.
   */
  it('starts the daemon when the sources entry runs from a foreign cwd', () => {
    const cwd = tempDir()
    // A `file://` URL, not a path: the ESM loader refuses a Windows `D:\...` specifier
    // (`ERR_UNSUPPORTED_ESM_URL_SCHEME`), and a bare `tsx` cannot resolve at all from the
    // foreign cwd this test deliberately runs in. `pathToFileURL` is right on all three.
    const entry = ['--import', pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, path.join(root, 'src', 'cli.ts')]
    const env = { ...process.env, HHOSTED_HOME: cwd, HHOSTED_PROJECT: cwd }

    const up = spawnSync(process.execPath, [...entry, 'up', '--home', cwd, '--port', '6395', '--no-autostart'], {
      cwd,
      encoding: 'utf8',
      timeout: 120_000,
      env,
    })

    // The regression's exact words, so a future failure names itself rather than just timing out.
    expect(up.stderr, up.stderr).not.toContain('is not supported resolving ES modules')
    expect(up.stdout + up.stderr).toContain('is up')

    // Bring it back down; the child is detached, so this is the only thing that stops it.
    spawnSync(process.execPath, [...entry, 'down', '--home', cwd], { cwd, encoding: 'utf8', timeout: 60_000, env })
  })

  it('reports the curated help through the bin, as a user would see it', () => {
    const cwd = tempDir()
    const result = runBin(['--help'], { cwd, built: true })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('home-hosted')
    // The command added most recently, so this fails if the registry stops being wired.
    expect(result.stdout).toContain('logs')
  })

  /**
   * There is deliberately no "passes the caller directory through as the project" case for the
   * built* path.
   *
   * The bin sets `cwd: hasBuild ? process.cwd() : root`, so on the built path the child already
   * inherits the caller's directory as its cwd, and `HHOSTED_PROJECT: process.env.HHOSTED_PROJECT ??
   * process.cwd()` resolves to that same directory. Deleting the passthrough changed nothing there
   * (verified: an `init`-based assertion built for this case still passed anyway), which is why the
   * case that used to sit here — `status` is 0 or 1, no module error, some output appeared — could
   * not fail.
   *
   * The passthrough is load-bearing on the **sources** path, where the bin pins `cwd: root` and the
   * env var is the only thing carrying the caller's directory. That is covered by the foreign-cwd
   * test above, which does fail when the passthrough is removed.
   */
})
