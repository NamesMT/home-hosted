import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The daemon's console log is opened `0600`, because on a first boot it carries a password.
 *
 * `src/cli/up.ts` redirects the child's stdout/stderr into `.hh/.logs/home-hosted.log`, and the
 * generated first-run password is announced there. Without a mode argument the file lands at `0644`
 * under the usual umask, so any local account could read a credential the panel otherwise keeps in a
 * 0600 file. `rotateLog` renames rather than rewrites, so the mode travels into the rotated copy too.
 *
 * Read from the source, not re-implemented: a test that performs the same `openSync` call proves
 * what Node already documents and would pass while `up.ts` lost the argument again.
 */
describe('the daemon console log is opened private', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/cli/up.ts'), 'utf8')

  it('passes 0600 to the open that creates it', () => {
    const opens = [...source.matchAll(/fs\.openSync\(daemonLogPath[^)]*\)/g)].map(match => match[0])
    expect(opens, 'the daemon log is opened exactly once here').toHaveLength(1)
    expect(opens[0], 'the mode argument is what keeps the first-run password private').toContain('0o600')
  })

  it('does not open it read-write or executable', () => {
    expect(source).not.toMatch(/openSync\(daemonLogPath,\s*['"][wa]{2}/)
  })
})
