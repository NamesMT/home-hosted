import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { dataRoot } from '#src/helpers/paths'
import { DEFAULT_HOME } from './test-home'

/**
 * The suite gives every test file a throwaway `$HHOSTED_HOME`, and the run fails if the real one is
 * touched (`test/support/real-home-guard.ts`).
 *
 * Both halves are worth pinning, because both fail silently. If `setupFiles` is dropped from
 * `vitest.config.ts`, this file's `dataRoot` is the developer's `~/.home-hosted` and the guard's
 * snapshot cannot notice — the suite simply starts writing there again, which is exactly how
 * `~/.home-hosted` came to be created by a test run in the first place. If the guard is dropped, a
 * file that *deletes* the variable (several reset it to exercise the default-home fallback) reaches
 * the real directory with nothing watching.
 */
describe('every test file is isolated from the real state directory', () => {
  it('resolves dataRoot into a scratch directory, not the developer’s home', () => {
    const redirection = 'the setup file must redirect HHOSTED_HOME before paths.ts is imported'
    expect(dataRoot, redirection).not.toBe(DEFAULT_HOME)
    expect(path.isAbsolute(dataRoot), 'and to an absolute path').toBe(true)
  })

  it('points at a directory the setup file created for this file alone', () => {
    expect(process.env.HHOSTED_HOME, 'the variable the paths module read').toBe(dataRoot)
    expect(dataRoot).toContain('hh-test-home-')
    // Created before the test file runs, so a test may write into it without a mkdir of its own.
    expect(fs.existsSync(dataRoot), 'the scratch home exists').toBe(true)
    // Nothing of the app's own state has been written yet: the directory is this file's alone.
    expect(fs.existsSync(path.join(dataRoot, '.hh')), 'and starts empty').toBe(false)
  })

  it('is registered in the vitest config, so the guard cannot be dropped by accident', () => {
    const config = fs.readFileSync(path.join(import.meta.dirname, '../../vitest.config.ts'), 'utf8')
    expect(config, 'setupFiles redirects the home').toContain('\'./test/support/test-home.ts\'')
    expect(config, 'globalSetup compares the real home before and after').toContain('\'./test/support/real-home-guard.ts\'')
  })
})
