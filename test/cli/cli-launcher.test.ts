import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { cliArgv } from '../support/run-cli'

/**
 * The launcher itself is the thing that broke Windows CI, so it is pinned rather than assumed.
 *
 * `node_modules/.bin/tsx` is a `#!/bin/sh` script: Windows has `tsx.cmd` there instead, so a spawn of
 * the POSIX path starts nothing and returns empty output. Spawning `process.execPath` with the loader
 * flag is the portable form, and an assertion on argv is the only way a Linux runner can defend it —
 * the old launcher passed every test on this machine.
 */
describe('the CLI launcher', () => {
  it('spawns node with the loader, never the POSIX `.bin` shim', () => {
    const argv = cliArgv(['status'], '/tmp/hh-home')

    expect(argv[0]).toBe(process.execPath)
    expect(argv).toContain('--import=tsx')
    expect(argv.join(' ')).not.toContain('node_modules/.bin')
    // `--home` stays a child argument: it is peeled off before any state module resolves a path.
    expect(argv.slice(argv.indexOf('--home') + 1, argv.indexOf('--home') + 2)).toEqual(['/tmp/hh-home'])
  })
})
