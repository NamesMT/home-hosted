import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'
import { runCli } from './run-cli'

/**
 * The `backup-args*` suites run the CLI against a throwaway home, one per file, because a missing
 * panel is the only thing their flag guards need. Call `backupArgsCli()` once, at a file's top level.
 */

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

  const options = { home, timeout: 60000, env: { NO_COLOR: '1' } }
  const run = (args: string[]) => runCli(args, options)
  // `runSplit` reads the streams apart, which is what a `--json` caller sees; `runCli` returns both.
  return { home, run, runSplit: run }
}
