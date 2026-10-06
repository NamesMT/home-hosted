import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

/**
 * The guard that decides whether a release may be dispatched.
 *
 * It runs in `release.yml` before changelogen bumps `package.json` and before npm publishes, so a
 * version it wrongly accepts reaches the publishing step and fails there with a message about
 * changelogen or npm rather than about the input. Nothing tested it — which is how I read its own
 * output wrong the first time I ran it (a `| head` in my pipeline reported `head`'s exit code, not
 * the script's).
 */
const script = path.join(process.cwd(), 'scripts', 'check-release-version.mjs')

function run(version: string): { code: number, out: string } {
  // `execFileSync` returns stdout only, and a successful run puts its *warning* on stderr — so the
  // success path is captured through `spawnSync`, which hands back both streams.
  const result = spawnSync(process.execPath, [script, version], { encoding: 'utf8' })
  return {
    code: result.status ?? -1,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

describe('check-release-version', () => {
  it('refuses anything that is not a version', () => {
    for (const value of ['', 'nonsense', 'v0.7.18', '0.7', '0.7.18.1', 'latest']) {
      const { code, out } = run(value)
      expect(code, value).toBe(1)
      expect(out).toContain('is not a version')
    }
  })

  /**
   * Semver forbids a leading zero in a numeric identifier, and npm enforces that — `semver.valid`
   * returns null for each of these. The guard's regex accepted them, so `0.7.018` passed the release
   * gate and would have failed later, at the publishing step, naming the wrong problem.
   */
  it('refuses a version with a leading zero, which semver and npm both reject', () => {
    for (const value of ['0.7.018', '0.07.18', '00.7.18']) {
      const { code, out } = run(value)
      expect(code, value).toBe(1)
      expect(out, value).toContain('is not a version')
    }
  })

  it('refuses a version that is not greater than the current one', () => {
    for (const value of ['0.7.0', '0.7.16', '0.7.17']) {
      const { code, out } = run(value)
      expect(code, value).toBe(1)
      expect(out).toContain('is not greater than the current')
    }
  })

  it('accepts the next patch and the next major', () => {
    expect(run('0.7.18').code).toBe(0)
    expect(run('1.0.0').code).toBe(0)
    expect(run('0.7.18-rc.1').code).toBe(0)
  })

  it('warns about a minor with no breaking commit behind it, without failing', () => {
    // Below 1.0 the minor is the breaking channel, so a minor with none pending is usually a patch
    // that was meant — a warning, not a refusal, since the person may know better.
    const { code, out } = run('0.8.0')
    expect(code).toBe(0)
    expect(out).toContain('no breaking commit pending')
  })
})
