/**
 * Shared test support. Not a test itself, so it carries no `.test.ts` suffix.
 *
 * `test/helpers/` holds the tests *for* `src/helpers/*`; this directory holds code the tests use.
 */
import type { DdnsConfig } from '#src/shared/contracts'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { type } from 'arktype'
import { ddnsConfigSchema } from '#src/shared/contracts'

/**
 * Whether `openssl` runs here, decided **once at module load**.
 *
 * Read at load, not inside a hook: `it.runIf`/`it.skipIf` is evaluated when the suite is collected, so
 * a condition computed in `beforeAll` is always truthy and the guarded test then reports a **pass** on
 * a machine that never ran the code. A skip says what actually happened.
 *
 * Eleven copies of this probe lived across five files; one definition, so a change to what "can run
 * openssl" means cannot reach some and miss others.
 */
export const hasOpenssl = ((): boolean => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  }
  catch {
    return false
  }
})()

/**
 * Whether `openssl req` accepts an explicit validity window (`-not_before`/`-not_after`).
 *
 * Added in OpenSSL 3.2, so a distro on 3.0 cannot mint a not-yet-valid certificate. A test for that
 * window has to skip rather than fail there — and a *real* probe, not a version comparison: the flag
 * is what matters, and `openssl` is often LibreSSL on macOS, whose version numbering differs.
 */
export const hasOpensslExplicitDates = ((): boolean => {
  if (!hasOpenssl)
    return false
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-openssl-dates-'))
    try {
      execFileSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        path.join(dir, 'k.pem'),
        '-out',
        path.join(dir, 'c.pem'),
        '-subj',
        '/CN=probe',
        '-not_before',
        '20300101000000Z',
        '-not_after',
        '20300201000000Z',
      ], { stdio: 'ignore' })
      return true
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  catch {
    return false
  }
})()

/** Whether this platform can run the POSIX process tests, read at module load for the same reason. */
export const isPosix = process.platform !== 'win32'

/**
 * Parse a DDNS config the way the app does, throwing on a bad one.
 *
 * Two test files carried this identically, and it encodes the house ArkType idiom — `instanceof
 * type.errors`, never `instanceof Error`. Stating it once means a test cannot accidentally assert the
 * wrong shape while the real one moves.
 */
export function parseDdnsConfig(input: unknown): DdnsConfig {
  const parsed = ddnsConfigSchema(input)
  if (parsed instanceof type.errors)
    throw new Error(parsed.summary)
  return parsed
}
