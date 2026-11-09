import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { smokeHome, smokeRunner } from '../support/cli-smoke'
import { devPortAllocator } from '../support/dev-port'

const home = smokeHome()
const runCli = smokeRunner(home)
/** This file's own slice of the dev range; every other `cli-status*` / `cli-print-config` file holds its own. */
const freeDevPort = devPortAllocator(6800, 6899)

/**
 * `status` has two outputs, and they must name the same paths.
 *
 * The text output gained the per-server log directory when the README's layout table started
 * naming those files; the `--json` output did not, so a script asking for the machine-readable
 * form got `logFile` (the panel console) and nothing for a server's logs. Two renderings of one
 * command are one behaviour, and this pins them together.
 */
describe('status paths in both outputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-status-json-'))
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('names the per-server log directory in text and in JSON', async () => {
    const started = runCli(['up', '--home', dir, '--port', String(await freeDevPort()), '--no-autostart'])
    try {
      expect(started.status, started.stderr).toBe(0)
      const logsDir = path.join(dir, '.hh', 'default', '.logs')

      const text = runCli(['status', '--home', dir])
      expect(text.stdout).toContain(logsDir)

      const json = runCli(['status', '--home', dir, '--json'])
      const parsed = JSON.parse(json.stdout) as { logsDir?: string, logFile?: string }
      expect(parsed.logsDir).toBe(logsDir)
      // And the console log stays distinct from it, in both.
      expect(parsed.logFile).not.toBe(parsed.logsDir)
      expect(text.stdout).toContain(parsed.logFile!)
    }
    finally {
      runCli(['down', '--home', dir])
    }
  })

  /**
   * Every row the text form prints must have a JSON counterpart.
   *
   * Both gaps found here were the same mistake — a field added to one output and not the other:
   * `logsDir` (text only) and `ui` (printed as a row, absent from JSON, so a script could not
   * learn which UI is installed). This pins the specific field that was missing.
   */
  it('reports the installed UI in both outputs', async () => {
    const started = runCli(['up', '--home', dir, '--port', String(await freeDevPort()), '--no-autostart'])
    try {
      expect(started.status, started.stderr).toBe(0)

      const text = runCli(['status', '--home', dir])
      expect(text.stdout, 'the text form has a ui row').toMatch(/^ {2}ui +stock$/m)

      const jsonOut = runCli(['status', '--home', dir, '--json']).stdout
      const parsed = JSON.parse(jsonOut) as { ui?: { custom?: boolean, name?: string } }
      expect(parsed.ui, 'text prints a ui row, so JSON must carry it too').toBeDefined()
      expect(parsed.ui!.custom).toBe(false)
      expect(parsed.ui!.name).toBe('stock')

      // The run.json token authorises a local shutdown, so it must not reach a script's stdout —
      // which is a file, a pipe and often a CI log. A running panel is what makes this meaningful:
      // the other `status --json` fixture has no `run.json`, so it cannot leak one either way.
      const token = (JSON.parse(fs.readFileSync(path.join(dir, '.hh', 'run.json'), 'utf8')) as { token?: string }).token
      expect(token, 'the running panel must have a token, or this proves nothing').toBeTruthy()
      expect(jsonOut, 'the status token must not be printed').not.toContain(token!)
    }
    finally {
      runCli(['down', '--home', dir])
    }
  })
})
