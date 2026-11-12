import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ERROR_CODES, statusOfCode } from '#src/shared/error-codes'
import { stripComments } from '../helpers/strip-comments'

/**
 * Every code the API can answer is in the catalogue.
 *
 * `docs/API.md` was the only list of error codes, and prose cannot be checked against the source:
 * "no such backup" answered `UNKNOWN_BACKUP` on one route and `BACKUP_NOT_FOUND` on another for
 * months, and a Node errno (`ERR_FS_CP_DIR_TO_NON_DIR`) travelled to clients in the same envelope as
 * the API's own codes. A code is a contract value, so the source is walked and every literal one must
 * be catalogued.
 *
 * The walk reads a **construct** — `code: '<LITERAL>'` in a `DetailedError` options object, a bare
 * `code: '<LITERAL>'` in an object literal, or a `statusCode`/`code` pair — not one spelling of it.
 * `AUTH_REQUIRED` and its neighbours are consts in `middleware/auth.ts`, so a code reached through an
 * identifier is not visible here; the catalogued set is a superset, which is what makes that safe.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))

const SOURCE = /\.ts$/
/** Where the API builds its answers. `src/shared` declares the types; the codes are thrown elsewhere. */
const CODE_SOURCES = [path.join(root, 'src')]

/** `code: 'SOMETHING'` — the one shape every `DetailedError` in this repo uses. */
const CODE_LITERAL = /(?<![.\w$])code:\s*'([A-Z][A-Z0-9_]*)'/g

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !SOURCE.test(entry.name))
      continue
    const file = path.join(entry.parentPath, entry.name)
    // The catalogue declares the codes; it is where they are allowed to appear without being thrown.
    if (file === path.join(root, 'src', 'shared', 'error-codes.ts'))
      continue
    files.push(file)
  }
  return files
}

interface CodeSite {
  code: string
  file: string
  line: number
}

/** Every literal code in `src/`, with where it came from, so a failure names the site. */
function codeSites(): CodeSite[] {
  const sites: CodeSite[] = []
  for (const dir of CODE_SOURCES) {
    for (const file of sourceFiles(dir)) {
      const source = stripComments(fs.readFileSync(file, 'utf8'))
      for (const match of source.matchAll(CODE_LITERAL)) {
        const index = match.index ?? 0
        sites.push({
          code: match[1]!,
          file: path.relative(root, file),
          line: source.slice(0, index).split('\n').length,
        })
      }
    }
  }
  return sites
}

describe('the error-code catalogue', () => {
  const sites = codeSites()

  // Anti-vacuity: a walk that finds nothing passes every assertion below for the wrong reason.
  it('finds the literal codes it claims to check', () => {
    expect(sites.length, 'the scan must see the codes the API throws').toBeGreaterThan(50)
    expect(new Set(sites.map(site => site.code)).size).toBeGreaterThan(40)
    // A code the scan must see, named explicitly so a broken regex is caught here and not by silence.
    expect(sites.some(site => site.code === 'UNKNOWN_SERVER')).toBe(true)
  })

  it('has every literal code in the catalogue', () => {
    const missing = sites
      .filter(site => !(site.code in ERROR_CODES))
      .map(site => `${site.code} at ${site.file}:${site.line}`)
    expect(missing, 'a code thrown by the API must be catalogued in src/shared/error-codes.ts').toEqual([])
  })

  /**
   * No Node errno escapes as an API code.
   *
   * The envelope says `{ message, code }` in the API's own vocabulary; an `ERR_*` from `fs` or
   * `child_process` reaching a client is a leak of the implementation, and a client cannot act on it.
   * (`ERR_FS_CP_DIR_TO_NON_DIR` was exactly that.)
   */
  it('carries no Node errno as a code', () => {
    const errnos = sites.filter(site => site.code.startsWith('ERR_')).map(site => `${site.code} at ${site.file}:${site.line}`)
    expect(errnos).toEqual([])
  })

  /** The catalogue itself must stay well-formed: a status inside HTTP's error range, and a meaning. */
  it('declares a usable status and a meaning for every entry', () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      expect(spec.status, code).toBeGreaterThanOrEqual(400)
      expect(spec.status, code).toBeLessThanOrEqual(599)
      expect(spec.meaning.length, code).toBeGreaterThan(10)
    }
  })

  it('answers a status for a catalogued code and none for an unknown one', () => {
    expect(statusOfCode('UNKNOWN_SERVER')).toBe(404)
    expect(statusOfCode('SERVER_BUSY')).toBe(409)
    expect(statusOfCode('NOT_A_REAL_CODE')).toBeNull()
  })

  /**
   * A code with two spellings for one condition is the defect this catalogue exists to prevent.
   *
   * The check is deliberately narrow — it looks for the *same meaning* under two names, which a
   * person writes when they add a second route without looking — by pinning the pair that was
   * wrong. A broader "all codes are distinct" test would be vacuous (the object keys are).
   */
  it('has one code for "no such backup"', () => {
    expect(ERROR_CODES).toHaveProperty('BACKUP_NOT_FOUND')
    expect(ERROR_CODES).not.toHaveProperty('UNKNOWN_BACKUP')
    expect(sites.some(site => site.code === 'BACKUP_NOT_FOUND'), 'the backup routes must use it').toBe(true)
    expect(sites.some(site => site.code === 'UNKNOWN_BACKUP')).toBe(false)
  })

  /** The catalogue is published, so the docs and a generated client read the same list. */
  it('is listed in docs/API.md', () => {
    const doc = fs.readFileSync(path.join(root, 'docs', 'API.md'), 'utf8')
    const unlisted = Object.keys(ERROR_CODES).filter(code => !doc.includes(code))
    expect(unlisted, 'every catalogued code must appear in docs/API.md').toEqual([])
  })
})

/** `process` is imported for `platform` guards in the repo's other scans; kept explicit here. */
void process
