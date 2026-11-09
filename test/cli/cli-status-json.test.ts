import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import { root, smokeHome, smokeRunner } from '../support/cli-smoke'
import { devPortAllocator } from '../support/dev-port'

const home = smokeHome()
const runCli = smokeRunner(home)
/** This file's own slice of the dev range; the sibling `cli-status*` files each hold another. */
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

/**
 * `--print-config` promises to print and exit, so it must not leave anything behind — and it must
 * answer on the one home a person most wants to inspect: a running panel's.
 *
 * Both halves were wrong. It ran *after* the boot-password branch, so asking a fresh home what it
 * would read wrote `.control-secrets.json` with the default `hh` in it; the next real `up` then
 * started on the boot password, and `set-password` was the only way back. And it ran *after* the
 * live-record guard, so `up --print-config` on a running panel answered "already running" and
 * exited 1 — for a command that starts nothing and whose whole purpose is reading.
 *
 * Both are asserted by observable file state and exit code, not by the sentence: a test that only
 * grepped the message would pass again the moment the write moved.
 */
describe('print-config leaves the home alone', () => {
  it('writes no credential on a home that has none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-print-config-'))
    try {
      const printed = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), 'up', '--print-config'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, HHOSTED_HOME: dir, HHOSTED_PROJECT: dir },
      })

      expect(printed.status, printed.stderr).toBe(0)
      // It really did print the config, so the assertion below is not "it did nothing".
      expect(() => JSON.parse(printed.stdout)).not.toThrow()
      expect(
        fs.existsSync(path.join(dir, '.hh', '.control-secrets.json')),
        'a read-only command must not arm a password',
      ).toBe(false)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers while a panel is running, instead of refusing as a second instance', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-print-config-'))
    const port = await freeDevPort()
    try {
      const started = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), 'up', '--port', String(port), '--no-autostart'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, HHOSTED_HOME: dir, HHOSTED_PROJECT: dir },
      })
      expect(started.status, started.stderr).toBe(0)

      const printed = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), 'up', '--print-config'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, HHOSTED_HOME: dir, HHOSTED_PROJECT: dir },
      })

      expect(printed.stderr, 'a read-only command is not the second panel to refuse').not.toContain('already running')
      expect(printed.status, printed.stderr).toBe(0)
      expect(() => JSON.parse(printed.stdout), printed.stdout).not.toThrow()
    }
    finally {
      spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), 'down'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, HHOSTED_HOME: dir, HHOSTED_PROJECT: dir },
      })
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
