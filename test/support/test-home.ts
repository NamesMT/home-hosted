import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll } from 'vitest'

/**
 * Every test file gets its own throwaway `$HHOSTED_HOME`, before it imports anything.
 *
 * `src/helpers/paths.ts` resolves `dataRoot` **once, at module load**. A test that sets
 * `process.env.HHOSTED_HOME` at the top of its own file is already too late: ESM hoists the imports,
 * so `paths.ts` has run and every path it exports points at the developer's real `~/.home-hosted` —
 * the module is initialised before a single line of the test body executes. Measured: a file that
 * assigned the variable on its fifth line still resolved `dataRoot` to `/home/<user>/.home-hosted`.
 *
 * That is not theoretical. `down-budget.test.ts` built a `WorkspaceStore` to read a stop budget, and
 * `WorkspaceStore.load()` *seeds* a missing config — so a suite run created `~/.home-hosted` holding
 * a `servers.config.json` and a `settings.json`, on the machine of whoever ran the tests.
 *
 * `setupFiles` runs once per test file, in that file's worker, **before** it is imported, which is the
 * only hook early enough. A per-file directory (rather than one per worker) also keeps files that
 * share a worker isolated from each other.
 *
 * A file that needs a particular layout still sets its own; it just has to point somewhere real.
 * `test/support/real-home-guard.ts` fails the run if anything reaches the default location anyway.
 */

/**
 * The default home, recorded before the variable is replaced.
 *
 * Published so the guard test can name the path it forbids rather than re-deriving it.
 */
export const DEFAULT_HOME = path.join(os.homedir(), '.home-hosted')

const override = process.env.HHOSTED_HOME?.trim()
// An explicit absolute override wins: a CI job or a developer may point the whole run elsewhere on
// purpose, and discarding that silently would be a surprise.
if (override === undefined || override.length === 0 || !path.isAbsolute(override)) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-test-home-'))
  process.env.HHOSTED_HOME = scratch
  // Registered in the setup file, so it belongs to the file being set up and runs when it finishes.
  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true })
  })
}

/**
 * The same for the one machine-wide location the panel writes: the WSL2 temperature helper and its
 * library under the Windows host's `%ProgramData%`, shared by every home. Always replaced — unlike the
 * home there is no legitimate reason for a test run to reach the real one.
 */
const programData = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-test-programdata-'))
process.env.HHOSTED_TEST_PROGRAMDATA = programData
afterAll(() => {
  fs.rmSync(programData, { recursive: true, force: true })
})
