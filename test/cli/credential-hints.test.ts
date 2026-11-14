import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import { runCli } from '../support/run-cli'

/**
 * What `account` and `init` say about themselves: the wording a person acts on.
 *
 * Every hint goes through `invocation()`, which carries `--home`: a hint hard-coding `home-hosted
 * account` pointed a person running against a project's own state at the default one.
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

describe('account secret', () => {
  it('names a short secret\'s length, never the secret itself', () => {
    runCli(['account', 'create', 'admin'], { home, env: { HHOSTED_SECRET: 'abc' } })
    const result = runCli(['account', 'secret', 'admin'], { home, env: { HHOSTED_SECRET: 'abc' } })
    expect(result.status, result.stderr).toBe(0)
    expect(result.output).toContain('3 characters is short')
    expect(result.output, 'the secret must not be echoed into scrollback or a CI log').not.toContain('"abc"')
  })

  it('creates an account and prints the secret once, with a hint that keeps --home', () => {
    const created = runCli(['account', 'create', 'teammate', '--scope', 'read'], { home })
    expect(created.status, created.stderr).toBe(0)
    expect(created.stdout, 'the generated secret is shown').toMatch(/hh_[\w-]+/)
    // The hint names the command that uses this account, and keeps `--home`.
    expect(created.stdout).toContain(`--home ${quotedHome} account`)

    const listed = runCli(['account', 'ls'], { home })
    expect(listed.stdout).toContain('teammate')
    expect(listed.stdout, 'a listing never prints a secret').not.toMatch(/hh_[\w-]{20,}/)
  })

  /**
   * `reset` is the recovery path, and it is the one a locked-out person reaches for. It replaces the
   * old `--clear`, which left nobody able to sign in at all.
   */
  it('resets an account to a fresh secret rather than locking the panel', () => {
    const before = runCli(['account', 'create', 'owner'], { home })
    expect(before.status, before.stderr).toBe(0)
    const first = /hh_[\w-]+/.exec(before.stdout)![0]

    const reset = runCli(['account', 'reset', 'owner'], { home })
    expect(reset.status, reset.stderr).toBe(0)
    const fresh = /hh_[\w-]+/.exec(reset.stdout)![0]
    expect(fresh, 'a reset gives a different secret').not.toBe(first)
    expect(reset.stdout, 'and names the id to sign in with').toContain('owner')
  })

  it('refuses to revoke the last account that can sign in', () => {
    const only = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-credential-only-'))
    try {
      runCli(['account', 'create', 'solo'], { home: only })
      const result = runCli(['account', 'revoke', 'solo'], { home: only })
      expect(result.status, 'refused, or the panel has no way in').toBe(1)
      expect(result.output).toContain('last account')
    }
    finally {
      fs.rmSync(only, { recursive: true, force: true })
    }
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
