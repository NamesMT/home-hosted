import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
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

  /**
   * `release-notes.mjs` lifts one CHANGELOG section for the GitHub release body. It interpolates the
   * version into a `RegExp` escaping only the dots, so any other metacharacter threw
   * (`0.7.18)` → `Unmatched ')'`) as a stack trace instead of the one-line usage error.
   *
   * Unreachable from the workflow — `check-release-version.mjs` runs earlier in the same job — but the
   * script is runnable by hand, and a stack trace names the wrong problem.
   */
  /**
   * The extractor must find its section whatever line ending the changelog has.
   *
   * `split('\n')` leaves a CR-only file as **one line**, so the anchored `^##` never matches and the
   * script reports a missing section for a version that exists — blaming the changelog rather than the
   * ending. Latent rather than live (CI is Linux; a Windows `core.autocrlf` checkout gives CRLF, which
   * works), but the failure is silent and misdiagnosing.
   */
  it('finds the section under every line ending', () => {
    const repo = path.join(process.cwd())
    const original = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8')
    // A version that exists in the shipped changelog, so the assertion is about the ending.
    const version = [...original.matchAll(/^## v(\d+\.\d+\.\d+)/gm)][0]?.[1]
    expect(version, 'the changelog must have at least one released version').toBeDefined()

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-notes-'))
    try {
      // Run the real script against a copy of the real changelog, in each ending.
      fs.cpSync(path.join(repo, 'scripts'), path.join(dir, 'scripts'), { recursive: true })
      const body = original.replace(/\r\n|\r/g, '\n')
      for (const [name, text] of [
        ['lf', body],
        ['crlf', body.replace(/\n/g, '\r\n')],
        ['cr', body.replace(/\n/g, '\r')],
      ] as const) {
        fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), text)
        const result = spawnSync(process.execPath, [path.join(dir, 'scripts', 'release-notes.mjs'), version!], { encoding: 'utf8' })
        expect(result.status, `${name}: ${result.stderr}`).toBe(0)
        expect(result.stdout, `${name} must find the section`).toContain(`v${version}`)
      }
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a malformed version in release-notes with a usage line, not a stack trace', () => {
    const notes = path.join(process.cwd(), 'scripts', 'release-notes.mjs')
    for (const value of ['0.7.18)', '[', 'nonsense', '']) {
      const result = spawnSync(process.execPath, [notes, value], { encoding: 'utf8' })
      expect(result.status, value).toBe(1)
      expect(`${result.stdout}${result.stderr}`, value).toContain('usage: release-notes.mjs')
      expect(result.stderr, `${value} must not throw`).not.toContain('Unmatched')
    }
  })

  it('warns about a minor with no breaking commit behind it, without failing', () => {
    // Below 1.0 the minor is the breaking channel, so a minor with none pending is usually a patch
    // that was meant — a warning, not a refusal, since the person may know better.
    const { code, out } = run('0.8.0')
    expect(code).toBe(0)
    expect(out).toContain('no breaking commit pending')
  })
})
