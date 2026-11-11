import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import { runCli } from '../support/run-cli'

/**
 * What `set-password`, `set-token` and `init` say about themselves: the wording a person acts on.
 *
 * Every hint goes through `invocation()`, which carries `--home`: a hint hard-coding `home-hosted
 * set-token --clear` pointed a person running against a project's own state at the default one.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-credential-hints-'))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-credential-scratch-'))
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(scratch, { recursive: true, force: true })
})

/**
 * How a hint quotes the `--home` path, per platform.
 *
 * `shellQuote` picks the quoting the person's shell needs: `'…'` on POSIX, `"…"` on Windows (where a
 * single-quoted path is not a string at all). These assertions used to hardcode `'…'`, so the whole
 * file failed on Windows against correct output — a test bug that hid real regressions there.
 */
const quotedHome = process.platform === 'win32' ? `"${home}"` : `'${home}'`

describe('set-password', () => {
  it('names a short password\'s length, never the password itself', () => {
    const result = runCli(['set-password'], { home, env: { HHOSTED_PASSWORD: 'abc' } })
    expect(result.status, result.stderr).toBe(0)
    expect(result.output).toContain('3 characters is short')
    expect(result.output, 'the password must not be echoed into scrollback or a CI log').not.toContain('"abc"')
  })

  /**
   * `--clear` used to say authentication was disabled. It is not: auth stays on, nobody can sign
   * in, and only this machine or an API token reaches the panel until a new password is set.
   */
  it('says what --clear really leaves behind, with a hint that keeps --home', () => {
    const result = runCli(['set-password', '--clear'], { home })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('nobody can sign in')
    expect(result.stdout).not.toContain('authentication stays disabled')
    expect(result.stdout).toContain(`--home ${quotedHome} set-password`)
  })
})

describe('set-token', () => {
  it('keeps --home in its hints', () => {
    const missing = runCli(['set-token'], { home, env: { HHOSTED_TOKEN: undefined } })
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain(`--home ${quotedHome} set-token --generate`)

    const generated = runCli(['set-token', '--generate'], { home })
    expect(generated.status, generated.stderr).toBe(0)
    expect(generated.stdout).toContain(`--home ${quotedHome} set-token --clear`)
  })
})

/** A failed dependency install is a failed `init`: on stderr, exit 1, and the install listed as a next step. */
describe.skipIf(process.platform === 'win32')('init with a failing install', () => {
  it('refuses on stderr and exits 1', () => {
    const bin = path.join(scratch, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    // A package manager that always fails, first on PATH.
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    const dir = path.join(scratch, 'project')

    const result = runCli(['init', '--yes', '--dir', dir, '--pm', 'npm'], {
      home,
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
    })
    expect(result.status, result.output).toBe(1)
    expect(result.stderr).toContain('the npm install failed')
    expect(result.stdout).toContain('npm install')
  })
})
