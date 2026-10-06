/**
 * Shared test support. Not a test itself, so it carries no `.test.ts` suffix.
 *
 * `test/helpers/` holds the tests *for* `src/helpers/*`; this directory holds code the tests use.
 */
import type { DdnsConfig } from '#src/shared/contracts'
import { execFileSync } from 'node:child_process'
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
