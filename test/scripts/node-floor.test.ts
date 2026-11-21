import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The runtime Node floor `bin/home-hosted.mjs` enforces must match `package.json#engines`.
 *
 * The guard exists because `engines` alone does not stop anything: npm only *warns* by default,
 * `--engine-strict=false` is common, and `pnpm dlx` or a global install can land on whatever `node` is
 * first on `PATH`. Without it the failure is whatever the first modern-API call happens to throw — an
 * `Unknown option --import` from the `tsx` fallback, or a `SyntaxError` deep in `dist/` — neither of
 * which names the cause.
 *
 * The floor is a literal in the entry point on purpose (reading the manifest would mean an `fs` call
 * before the check that reports a broken runtime), so the two copies can drift. This is what stops
 * them: bump `engines` without touching the guard and it fails, and the reverse does too.
 */
describe('the Node floor is enforced and not just declared', () => {
  it('declares the same major in package.json#engines and in the entry point', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      engines?: { node?: string }
    }
    const declared = /(\d+)/.exec(pkg.engines?.node ?? '')?.[1]
    expect(declared, 'package.json#engines.node must name a minimum version').toBeTruthy()

    const entry = readFileSync(new URL('../../bin/home-hosted.mjs', import.meta.url), 'utf8')
    const enforced = /const REQUIRED_MAJOR = (\d+)/.exec(entry)?.[1]
    expect(enforced, 'bin/home-hosted.mjs must enforce a major version').toBeTruthy()

    expect(
      enforced,
      `the entry point refuses below Node ${enforced} while package.json declares ${pkg.engines?.node} — the two must agree`,
    ).toBe(declared)
  })

  it('refuses before it spawns anything, so an old runtime never sees a confusing error', () => {
    const entry = readFileSync(new URL('../../bin/home-hosted.mjs', import.meta.url), 'utf8')
    // The check must precede the `spawn`, or the child fails with the error the guard exists to replace.
    const check = entry.indexOf('REQUIRED_MAJOR')
    const spawn = entry.indexOf('spawn(process.execPath')
    expect(check, 'the version check must be in the entry point').toBeGreaterThan(-1)
    expect(spawn, 'the entry point must still spawn the CLI').toBeGreaterThan(-1)
    expect(check, 'the version check must run before the child is spawned').toBeLessThan(spawn)
  })

  it('keeps the guard honest about the current runtime, which passes it', () => {
    // Anti-vacuity: this test suite runs on a Node the guard accepts, so the boundary below it is the
    // interesting one and it is what the message names.
    const entry = readFileSync(new URL('../../bin/home-hosted.mjs', import.meta.url), 'utf8')
    const required = Number(/const REQUIRED_MAJOR = (\d+)/.exec(entry)?.[1])
    const running = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
    expect(running, `this suite runs on Node ${process.versions.node}, below the floor it asserts`).toBeGreaterThanOrEqual(required)
  })
})
