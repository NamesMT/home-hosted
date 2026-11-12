import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { CONFIG_SCHEMA } from '#src/config/migrations'
import { runCli } from '../support/run-cli'

/**
 * What `set-token` tells a person, and what it got wrong.
 *
 * Two separate promises:
 *
 * 1. **What a token cannot do.** The closing note said the only exception was clearing the password.
 *    `docs/API.md` and `docs/SECURITY.md` both list more (`403 SESSION_REQUIRED`), and every one of
 *    those is a way a leaked token could lock its owner out of the panel — so the note a person reads
 *    at the moment they copy a token is the worst place to understate it.
 * 2. **The URL it prints.** The curl hint fell back to a hard-coded `3999` when no panel was running,
 *    so a home configured on another port was shown a URL nothing listens on — in the line the
 *    reader was just told to paste into a script.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The refusals, phrased as the docs phrase them and as the command prints them.
 *
 * Each was checked against its own guard in `src/api/`, not copied from the brief:
 *
 * - clearing the password — `DELETE /api/auth/password`, `api/auth/$.routes.ts`
 * - switching authentication off — `PATCH /api/settings`, `api/settings.ts`
 * - minting or revoking an API token — `POST`/`DELETE /api/auth/token`, `api/auth/$.routes.ts`
 * - setting the *first* password — `POST /api/auth/password`, `api/auth/$.routes.ts` (changing an
 *   existing one with `currentPassword` *is* allowed to a token, which is why "first" matters)
 * - installing a custom UI — `POST /api/settings/ui`, `api/settings.ts`
 * - restoring an archive that carries the panel's own credentials — `POST /api/backups/restore`,
 *   `api/backups.ts`
 */
const REFUSALS = [
  'clearing the password',
  'switching authentication off',
  'minting or revoking an API token',
  'setting the first password',
  'installing a custom UI',
  'restoring an archive that carries the panel\'s own credentials',
]

const homes: string[] = []
afterAll(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function newHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-set-token-'))
  homes.push(home)
  return home
}

/** A home with `settings.json`, the way a panel writes it when `up --port` moved the listener. */
function homeOnPort(port: number): string {
  const home = newHome()
  const hh = path.join(home, '.hh')
  fs.mkdirSync(hh, { recursive: true })
  fs.writeFileSync(path.join(hh, 'settings.json'), JSON.stringify({
    meta: { writtenBy: 'test', schema: CONFIG_SCHEMA },
    control: { port, host: 'local' },
  }, null, 2))
  return home
}

describe('set-token says what a token cannot do', () => {
  it('names every operation the API refuses an API token', () => {
    const result = runCli(['set-token', '--generate'], { home: newHome() })
    expect(result.status, result.stderr).toBe(0)

    for (const refusal of REFUSALS)
      expect(result.stdout, `the note must name: ${refusal}`).toContain(refusal)

    // The old wording promised a browser's access "except clearing the panel password", which is
    // exactly the understatement this replaced.
    expect(result.stdout).not.toContain('except clearing the panel password')
    // It is still a full-admin warning, not a list of what a token can do.
    expect(result.stdout).toContain('same access as a signed-in browser')
    expect(result.stdout).toContain('403 SESSION_REQUIRED')
  })

  /**
   * The printed list and the docs must agree. The brief asks for exactly that, and the note is read
   * at the moment someone copies a token into a script — the one place an understatement is acted on.
   * This reads the paragraph out of `docs/API.md`, so a doc edit that adds a seventh refusal without
   * the command (or the reverse) fails here.
   */
  it('names the same refusals docs/API.md names', () => {
    const api = fs.readFileSync(path.join(root, 'docs/API.md'), 'utf8')
    // The warning paragraph, from the sentence that introduces the list to the blank line after it.
    // Its blockquote markers go first: a phrase that wraps would otherwise compare against `> `.
    const start = api.indexOf('A few operations are still')
    expect(start, 'docs/API.md must still carry the refusal paragraph this test reads').toBeGreaterThan(-1)
    const end = api.indexOf('\n\n', start)
    const doc = api.slice(start, end === -1 ? undefined : end)
      .replace(/^\s*>\s?/gm, '')
      // Emphasis markers, so `setting the *first* password` compares as the plain phrase.
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .toLowerCase()
    const printed = runCli(['set-token', '--generate'], { home: newHome() }).stdout.replace(/\s+/g, ' ').toLowerCase()

    for (const refusal of REFUSALS) {
      const phrase = refusal.toLowerCase()
      expect(doc, `docs/API.md must name "${refusal}"`).toContain(phrase)
      expect(printed, `set-token must print "${refusal}"`).toContain(phrase)
    }
  })
})

describe('set-token prints a URL that can be used', () => {
  it('uses the port the home is configured on, with no panel running', () => {
    const result = runCli(['set-token', '--generate'], { home: homeOnPort(4123) })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('http://127.0.0.1:4123/api/state')
    expect(result.stdout, 'the default port must not appear when the home names another one').not.toContain(':3999')
  })

  it('falls back to 3999 on a home with no settings file, without creating one', () => {
    const home = newHome()
    const result = runCli(['set-token', '--generate'], { home })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('http://127.0.0.1:3999/api/state')

    // The read is `{ write: false }` (AGENTS.md, *State*): a command that only looks must not seed
    // a settings file on a home that has none.
    expect(fs.existsSync(path.join(home, '.hh', 'settings.json')), 'set-token must not seed settings.json').toBe(false)
  })

  /**
   * A settings file this release cannot read must not be silently replaced with 3999 — that is the
   * same wrong-URL bug one hand edit away. The hint says it does not know the port rather than
   * inventing one.
   */
  it('does not invent 3999 for a settings file it cannot read', () => {
    const home = newHome()
    fs.mkdirSync(path.join(home, '.hh'), { recursive: true })
    fs.writeFileSync(path.join(home, '.hh', 'settings.json'), '{ not json')

    const result = runCli(['set-token', '--generate'], { home })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain(':3999')
    expect(result.stdout).toContain('<port>')
  })
})
