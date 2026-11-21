import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The release body must carry **every** migration a person has to read, not just the matching number.
 *
 * This branch carried three releases' worth of breaking work at once — the account model, the
 * 12-character exposure bar, and jobs leaving the server entry — with a section written for `0.14.0`,
 * `0.15.0` and `0.16.0` as though they would ship one after another. They could not: `package.json`
 * was still at `0.13.0`, so one dispatch would ship all three changes while the body printed the
 * migration for only the version whose number was dispatched. The two it dropped were the ones a
 * person must act on, so the release would have read as if nothing needed doing.
 *
 * The script reads its root from its own location, so the cases here run against a throwaway root —
 * the same shape `release-version.test.ts` uses, and for the same reason: asserting against this
 * repository's real files turns red when they change for unrelated reasons.
 */
const repo = process.cwd()
const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * A root holding the script, a CHANGELOG section for `version`, and the given UPGRADING sections in
 * the order they appear in the document (which is newest-first, as the real file is).
 */
function project(options: { version: string, sections: Array<{ version: string, body: string }> }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-notes-'))
  roots.push(dir)
  fs.cpSync(path.join(repo, 'scripts'), path.join(dir, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.agentDocs'), { recursive: true })

  fs.writeFileSync(
    path.join(dir, 'CHANGELOG.md'),
    `# Changelog\n\n## v${options.version.split('.')[0]}.${options.version.split('.')[1]}.${options.version.split('.')[2]}\n\n### Fixes\n\n- something\n\n## v0.13.0\n\n- older\n`,
  )

  const upgrading = ['# Upgrading', '']
  for (const section of options.sections) {
    upgrading.push(`## ${section.version}`, '', section.body, '')
  }
  fs.writeFileSync(path.join(dir, '.agentDocs', 'UPGRADING.md'), upgrading.join('\n'))
  return dir
}

function notes(dir: string, version: string): string {
  const result = spawnSync(process.execPath, [path.join(dir, 'scripts', 'release-notes.mjs'), version], { encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`release-notes exited ${result.status}: ${result.stderr}`)
  return result.stdout
}

const THREE = [
  { version: '0.16.0', body: '**Jobs left the server entry.** Run `home-hosted migrate`.' },
  { version: '0.15.0', body: '**A password is now an account.** Sign in as `default`.' },
  { version: '0.14.0', body: '**Exposing the panel needs 12 characters.**' },
]

describe('release-notes carries every pending migration', () => {
  it('includes all earlier sections, not only the one whose number matches', () => {
    const dir = project({ version: '0.16.0', sections: THREE })
    const body = notes(dir, '0.16.0')

    // The bug: only the 0.16.0 paragraph used to be printed, so a person reading the release was told
    // about jobs and not about the credential change or the exposure bar.
    expect(body).toContain('Jobs left the server entry')
    expect(body, 'the account migration was dropped').toContain('A password is now an account')
    expect(body, 'the exposure migration was dropped').toContain('Exposing the panel needs 12 characters')
  })

  it('orders them oldest first, which is the order they must be applied', () => {
    const dir = project({ version: '0.16.0', sections: THREE })
    const body = notes(dir, '0.16.0')

    const exposure = body.indexOf('Exposing the panel needs 12 characters')
    const accounts = body.indexOf('A password is now an account')
    const jobs = body.indexOf('Jobs left the server entry')
    expect(exposure).toBeLessThan(accounts)
    expect(accounts).toBeLessThan(jobs)
  })

  it('leaves out a section for a later release', () => {
    const dir = project({
      version: '0.15.0',
      sections: [
        { version: '0.16.0', body: '**A future change nobody should read yet.**' },
        { version: '0.15.0', body: '**A password is now an account.**' },
      ],
    })
    const body = notes(dir, '0.15.0')
    expect(body).toContain('A password is now an account')
    expect(body, 'a later release leaked into this body').not.toContain('A future change nobody should read yet')
  })

  it('prints one section without a sub-heading, and several with them', () => {
    const single = project({ version: '0.14.0', sections: [{ version: '0.14.0', body: '**Only one change.**' }] })
    expect(notes(single, '0.14.0')).not.toContain('### 0.14.0')

    const many = project({ version: '0.16.0', sections: THREE })
    const body = notes(many, '0.16.0')
    for (const version of ['0.14.0', '0.15.0', '0.16.0'])
      expect(body, `no sub-heading for ${version}`).toContain(`### ${version}`)
  })

  it('ships the changelog alone when nothing needs a migration', () => {
    const dir = project({ version: '0.14.0', sections: [] })
    const body = notes(dir, '0.14.0')
    expect(body).toContain('- something')
    expect(body).not.toContain('## Upgrading')
  })
})
