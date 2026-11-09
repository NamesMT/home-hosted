import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { smokeHome, smokeRunner } from '../support/cli-smoke'
import { testPort } from '../support/ports'

/**
 * `status` is where an operator looks for a path, and its text and `--json` outputs must name the
 * same ones. One panel serves every running-panel case: each `up` costs seconds, and no case here
 * changes what the panel reports except the server log the convention case writes and removes.
 */
const home = smokeHome('hh-status-')
const runCli = smokeRunner(home)

describe('status with no running panel', () => {
  /**
   * "Not running" and "never set up" are different answers, and only one of them needs a next step:
   * a directory with no `workspaces.json` was never initialised.
   */
  it('tells a never-initialised directory what to do next', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-fresh-'))
    try {
      const result = runCli(['status', '--home', empty])
      expect(result.status, result.stderr).toBe(1)
      expect(result.stdout).toContain('home-hosted is not running')
      // `init` specifically: the other branch also offers `up`, so matching either proved nothing.
      expect(result.stdout, 'a fresh home must name `init`, not just the running state').toContain('init')
      // The hint names how this process was invoked, never the installed-bin spelling an `npx` user lacks.
      expect(result.stdout, 'the hint must be runnable, not the installed-bin spelling').not.toContain('`home-hosted init`')
    }
    finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('status against a running panel', () => {
  const logsDir = path.join(home, '.hh', 'default', '.logs')

  beforeAll(async () => {
    const started = runCli(['up', '--home', home, '--port', String(await testPort()), '--no-autostart'])
    expect(started.status, started.stderr).toBe(0)
  })
  afterAll(() => {
    runCli(['down', '--home', home])
  })

  it('prints every path it documents, aligned', () => {
    const result = runCli(['status', '--home', home])
    expect(result.status, result.stderr).toBe(0)

    // Printed, not required to exist: the directory appears when a server first writes a log.
    expect(result.stdout).toContain(logsDir)
    expect(result.stdout).toContain(path.join(home, '.hh', '.logs', 'home-hosted.log'))

    // Every value starts at the same column (labels are padded to a common width), read from the
    // real output with its colour codes stripped.
    // eslint-disable-next-line no-control-regex
    const plain = result.stdout.replace(/\u001B\[[0-9;]*m/g, '')
    const valueColumns = plain
      .split('\n')
      .map(line => /^ {2}\S+ +/.exec(line)?.[0].length)
      .filter((column): column is number => column !== undefined)
    expect(valueColumns.length, 'no label rows parsed from status').toBeGreaterThan(5)
    expect(new Set(valueColumns).size, `values start at columns ${[...new Set(valueColumns)].join(', ')}`).toBe(1)
  })

  it('names the per-server log directory in text and in JSON', () => {
    const text = runCli(['status', '--home', home])
    expect(text.stdout).toContain(logsDir)

    const parsed = JSON.parse(runCli(['status', '--home', home, '--json']).stdout) as { logsDir?: string, logFile?: string }
    expect(parsed.logsDir).toBe(logsDir)
    // The console log stays distinct from it, in both.
    expect(parsed.logFile).not.toBe(parsed.logsDir)
    expect(text.stdout).toContain(parsed.logFile!)
  })

  /** Every row the text form prints must have a JSON counterpart; `ui` was once text-only. */
  it('reports the installed UI in both outputs, and never the run.json token', () => {
    const text = runCli(['status', '--home', home])
    expect(text.stdout, 'the text form has a ui row').toMatch(/^ {2}ui +stock$/m)

    const jsonOut = runCli(['status', '--home', home, '--json']).stdout
    const parsed = JSON.parse(jsonOut) as { ui?: { custom?: boolean, name?: string } }
    expect(parsed.ui, 'text prints a ui row, so JSON must carry it too').toBeDefined()
    expect(parsed.ui!.custom).toBe(false)
    expect(parsed.ui!.name).toBe('stock')

    // The token authorises a local shutdown, so it must not reach a script's stdout.
    const token = (JSON.parse(fs.readFileSync(path.join(home, '.hh', 'run.json'), 'utf8')) as { token?: string }).token
    expect(token, 'the running panel must have a token, or this proves nothing').toBeTruthy()
    expect(jsonOut, 'the status token must not be printed').not.toContain(token!)
  })

  /**
   * `logs` reads the panel's console, so `status` is the only place a shell user learns that the entry
   * `api` writes `api.log`. The convention is shown only once the directory exists.
   */
  it('explains the per-server filename only once there are server logs', () => {
    const before = runCli(['status', '--home', home])
    expect(before.stdout).toContain(logsDir)
    expect(before.stdout, 'no convention before any log exists').not.toContain('<id>.log')

    fs.mkdirSync(logsDir, { recursive: true })
    try {
      fs.writeFileSync(path.join(logsDir, 'api.log'), '')
      expect(runCli(['status', '--home', home]).stdout).toContain('<id>.log')
      // The JSON stays a bare path: this is prose for a person, not a field for a script.
      expect(JSON.parse(runCli(['status', '--home', home, '--json']).stdout).logsDir).toBe(logsDir)
    }
    finally {
      fs.rmSync(logsDir, { recursive: true, force: true })
    }
  })
})
