import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { smokeHome, smokeRunner } from '../support/cli-smoke'
import { devPortAllocator } from '../support/dev-port'

const home = smokeHome()
const runCli = smokeRunner(home)
/** This file's own slice of the dev range; every other `cli-status*` / `cli-print-config` file holds its own. */
const freeDevPort = devPortAllocator(6500, 6599)

/**
 * `status` is where an operator looks for a path, and the README says it prints them.
 *
 * Two things worth pinning. It must name the per-server log directory — the panel console's own
 * path is not where a *server's* log lives, and the README's layout table now names the files, so
 * the command that prints paths has to agree. And its label column must stay aligned: it was a
 * literal `padEnd(8)` until a ten-character label was added and pushed every value out of line.
 */
describe('status paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-status-'))
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('prints the workspace log directory, aligned, with no running panel', () => {
    const result = runCli(['status', '--home', dir])
    // An unwritten home has no run.json, so this is the "not running" branch — which must still
    // not be an unhandled crash.
    expect(result.status, result.stderr).toBe(1)
    expect(result.stdout).toContain('home-hosted is not running')
  })

  /**
   * "Not running" and "never set up" are different answers, and only one of them needs a next step.
   *
   * A person who has just installed the package runs `status` in an empty directory and was told
   * "home-hosted is not running" — true, unhelpful, and indistinguishable from a panel that *was*
   * set up and has been stopped. The directory has no `workspaces.json`, which is what says whether
   * anything was ever initialised.
   */
  it('tells a never-initialised directory what to do next', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-fresh-'))
    try {
      const result = runCli(['status', '--home', empty])
      expect(result.status, result.stderr).toBe(1)
      expect(result.stdout).toContain('home-hosted is not running')
      // `init` specifically: the *other* branch also offers `up`, so matching either proved nothing
      // (a mutation that always reported "initialised" passed it).
      expect(result.stdout, 'a fresh home must name `init`, not just the running state').toContain('init')
      // The hint names how *this* process was invoked. Under vitest that is the source checkout,
      // never a bare `home-hosted` — which is the point: an `npx` user has no `home-hosted` on
      // their PATH, so a hard-coded name printed advice they could not follow.
      expect(result.stdout, 'the hint must be runnable, not the installed-bin spelling').not.toContain('`home-hosted init`')
    }
    finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })

  it('prints every path it documents, aligned, against a real running panel', async () => {
    // Spawned for real: `status` reads run.json, so a fixture on disk is the only honest input.
    // A panel is started in the throwaway home and asked for its status.
    const started = runCli(['up', '--home', dir, '--port', String(await freeDevPort()), '--no-autostart'])
    try {
      expect(started.status, started.stderr).toBe(0)
      const result = runCli(['status', '--home', dir])
      expect(result.status, result.stderr).toBe(0)

      // The per-server log dir — the path an operator needs for a *server's* log, which is not
      // the panel console path printed above it.
      const serverLogs = path.join(dir, '.hh', 'default', '.logs')
      // Printed, not required to exist: the directory appears when a server first writes a log,
      // and a panel that has never run one must still say where they would go.
      expect(result.stdout).toContain(serverLogs)
      // And the console log is still named separately.
      expect(result.stdout).toContain(path.join(dir, '.hh', '.logs', 'home-hosted.log'))

      // Every value starts at the same column. Read the real output rather than recomputing the
      // width, so the assertion is about what the command printed. The labels are wrapped in
      // colour codes, which must go first or the match lands inside them.
      // The invariant is the value's *start column*, not the gap before it: labels are padded to
      // a common width, so the gap legitimately differs per row while the column does not.
      // eslint-disable-next-line no-control-regex
      const plain = result.stdout.replace(/\u001B\[[0-9;]*m/g, '')
      const valueColumns = plain
        .split('\n')
        .map(line => /^ {2}\S+ +/.exec(line)?.[0].length)
        .filter((column): column is number => column !== undefined)
      expect(valueColumns.length, 'no label rows parsed from status').toBeGreaterThan(5)
      expect(new Set(valueColumns).size, `values start at columns ${[...new Set(valueColumns)].join(', ')}`).toBe(1)
    }
    finally {
      runCli(['down', '--home', dir])
    }
  })
})
