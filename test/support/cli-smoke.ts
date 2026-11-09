import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll } from 'vitest'
import { runCli } from './run-cli'

/**
 * The spawned-process CLI smoke suites (`test/cli/cli-smoke*.test.ts`, `cli-status*.test.ts`).
 *
 * Each file gets its own throwaway home, so the suite stays away from a real one and two files
 * running in parallel never share state.
 */

export const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * A scratch home for the calling file, swept after it; a leaked temp dir fails no assertion.
 * Call it at the top level of a test file.
 */
export function smokeHome(prefix = 'hh-cli-smoke-'): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}

/** `home-hosted <args>` with `home` as both `HHOSTED_HOME` and `HHOSTED_PROJECT`. */
export function smokeRunner(home: string): (args: string[]) => { status: number | null, stdout: string, stderr: string } {
  return args => runCli(args, { env: { HHOSTED_HOME: home, HHOSTED_PROJECT: home } })
}
