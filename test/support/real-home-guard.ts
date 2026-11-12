import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Fails the whole run if anything wrote to the developer's real state directory.
 *
 * `test/support/test-home.ts` redirects `$HHOSTED_HOME` per test file, which is what should make
 * this impossible. This is the guard *on* that guard: a setup file only covers code that reads the
 * variable when it is set, and a test that deletes it (several reset it to exercise the fallback)
 * would reach the default again. A snapshot taken before the suite and compared after it catches
 * that however it happened — a new file, a changed file, or the directory appearing at all.
 *
 * `globalSetup` runs once, outside the workers, and a throw from its returned teardown makes the run
 * exit non-zero (verified — `TestProject._teardownGlobalSetup` reports it as an error during close).
 *
 * Snapshotted rather than assumed-absent: a developer who legitimately runs a panel on this machine
 * has a real `~/.home-hosted`, and failing every test run because of it would be the same "guard that
 * gets disabled" problem. What matters is that the suite did not *change* it.
 */

/** Every file under `dir`, with size and mtime, so a rewrite is visible even when the name is the same. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (current: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    }
    catch {
      // Gone or unreadable between the listing and the walk: the parent's own stamp covers it.
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      try {
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        const stat = fs.statSync(full)
        out.set(path.relative(dir, full), `${stat.size}:${stat.mtimeMs}`)
      }
      catch {
        out.set(path.relative(dir, full), 'unstatable')
      }
    }
  }
  walk(dir)
  return out
}

export interface RealHomeGuard {
  /** The directory this run promised not to touch. */
  home: string
}

/**
 * The machine-wide spot besides the home: on a WSL2 guest the temperature helper and its library live
 * under the Windows host's `%ProgramData%`, shared by every home. A test run once wrote over and then
 * deleted a working helper there. `/mnt/c` is the usual system drive; elsewhere this is simply absent.
 */
const HOST_PROGRAM_DATA = '/mnt/c/ProgramData/home-hosted'

export async function setup(): Promise<() => Promise<void>> {
  // `os.homedir()` here, not `#src/helpers/paths`: that module resolves at import time and this file
  // must not drag the app's state into the runner before the per-file redirect is in place.
  const guarded = [path.join(os.homedir(), '.home-hosted'), HOST_PROGRAM_DATA]
  const before = new Map(guarded.map(dir => [dir, snapshot(dir)]))

  return async () => {
    const lines: string[] = []
    for (const dir of guarded) {
      const was = before.get(dir)!
      const now = snapshot(dir)
      const added = [...now.keys()].filter(key => !was.has(key))
      const changed = [...now.keys()].filter(key => was.has(key) && was.get(key) !== now.get(key))
      const removed = [...was.keys()].filter(key => !now.has(key))
      if (added.length + changed.length + removed.length === 0)
        continue
      // Named, not just counted: the point is to be able to put it back and fix the test that did it.
      lines.push(
        `the test run changed ${dir}`,
        ...added.map(file => `  created  ${file}`),
        ...changed.map(file => `  modified ${file}`),
        ...removed.map(file => `  deleted  ${file}`),
      )
    }
    if (lines.length === 0)
      return
    lines.push(
      '',
      'A test must not reach real state. `src/helpers/paths.ts` resolves `dataRoot` once at import, so a',
      'file that sets `process.env.HHOSTED_HOME` in its body is already too late; the WSL helper honours',
      '`HHOSTED_TEST_PROGRAMDATA`, which `test/support/test-home.ts` sets. Point the test at `mkdtemp`.',
    )
    throw new Error(lines.join('\n'))
  }
}
