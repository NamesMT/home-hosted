import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { smokeHome, smokeRunner } from '../support/cli-smoke'
import { devPortAllocator } from '../support/dev-port'

const home = smokeHome()
const runCli = smokeRunner(home)
/** This file's own slice of the dev range; every other `cli-status*` / `cli-print-config` file holds its own. */
const freeDevPort = devPortAllocator(6700, 6799)

/** The rest of `status paths` is in `cli-status-paths.test.ts`; this case starts its own panel, so it runs apart. */
describe('status paths', () => {
  /**
   * `home-hosted logs` reads the *panel's* console, not a server's, so `status` is the only place a
   * shell user can learn where a server's own output went. Knowing the directory is not enough —
   * the entry `api` writes `api.log`, and nothing else says so.
   *
   * The convention is shown only when the directory exists: naming a filename pattern for logs that
   * have never been written sends someone looking for a file that is not there.
   */
  it('explains the per-server filename only once there are server logs', async () => {
    // Its own home: the tests above share one, and a server log left behind by another case would
    // make the "no convention yet" assertion depend on execution order.
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-status-convention-'))
    const started = runCli(['up', '--home', own, '--port', String(await freeDevPort()), '--no-autostart'])
    try {
      expect(started.status, started.stderr).toBe(0)
      const logsDir = path.join(own, '.hh', 'default', '.logs')

      // With no server having run, the path alone is the whole answer.
      const before = runCli(['status', '--home', own])
      expect(before.stdout).toContain(logsDir)
      expect(before.stdout, 'no convention before any log exists').not.toContain('<id>.log')

      // A server having run leaves its file behind; now the naming matters.
      fs.mkdirSync(logsDir, { recursive: true })
      fs.writeFileSync(path.join(logsDir, 'api.log'), '')

      const after = runCli(['status', '--home', own])
      expect(after.stdout).toContain('<id>.log')

      // And the JSON stays a bare path: this is prose for a person, not a field for a script.
      const json = runCli(['status', '--home', own, '--json'])
      expect(JSON.parse(json.stdout).logsDir).toBe(logsDir)
    }
    finally {
      runCli(['down', '--home', own])
      fs.rmSync(own, { recursive: true, force: true })
    }
  })
})
