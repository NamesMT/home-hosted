import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll } from 'vitest'

/**
 * The `backup-args*` suites run the CLI against a throwaway home, one per file, because a missing
 * panel is the only thing their flag guards need. Call `backupArgsCli()` once, at a file's top level.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))

export function backupArgsCli(): {
  /** The throwaway home, which a test may also hand the CLI as a path. */
  home: string
  run: (args: string[]) => { status: number | null, output: string }
  runSplit: (args: string[]) => { status: number | null, stdout: string, stderr: string }
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-backup-args-'))

  /** This file's scratch home; a leaked temp dir fails no assertion, so it is swept here. */
  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  function run(args: string[]): { status: number | null, output: string } {
    const result = spawnSync(process.execPath, ['--import=tsx', path.join(root, 'src/cli.ts'), ...args, '--home', home], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, HHOSTED_HOME: home, NO_COLOR: '1' },
    })
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }

  /** The same run with the two streams kept apart, which is what a `--json` caller sees. */
  function runSplit(args: string[]): { status: number | null, stdout: string, stderr: string } {
    const result = spawnSync(process.execPath, ['--import=tsx', path.join(root, 'src/cli.ts'), ...args, '--home', home], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, HHOSTED_HOME: home, NO_COLOR: '1' },
    })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  return { home, run, runSplit }
}
