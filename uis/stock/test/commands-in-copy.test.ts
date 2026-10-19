import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A command printed in the UI is a promise the package has to keep.
 *
 * The login page's rescue line — the one sentence a locked-out user is given — told them to run
 * `pnpm run auth:set-password`, which has never existed in `package.json` (the script is
 * `set-password`). Nothing failed: it was a string in a template, so it rendered forever and only
 * a person following it found out. A UI must name the CLI, which is versioned with the panel,
 * rather than a package script that only someone inside this repo can run.
 */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const repoRoot = path.resolve(root, '..', '..')

/** Any `pnpm …` mention, for the second guard which only needs to know one exists. */
const ANY_PNPM = /\bpnpm (?:run\s+)?[a-z][\w:-]*/g

/** The file kinds a UI keeps copy in: templates, modules, and the sheet's CSV. */
const SUPPORTED = /\.(?:vue|ts|csv)$/

/** Only templates and modules carry copy a user reads; a sheet is data, checked above. */
const COPY_SOURCES = /\.(?:vue|ts)$/

/** `pnpm run <name>` / `pnpm <name>` occurrences in a UI's source. */
const PNPM_SCRIPT = /\bpnpm (?:run\s+)?([a-z][\w:-]*)/g

function uiSources(): string[] {
  const files: string[] = []
  for (const ui of ['stock', 'noc-console']) {
    for (const dir of ['src', 'i18n/sheets']) {
      const base = path.join(repoRoot, 'uis', ui, dir)
      if (!fs.existsSync(base))
        continue
      for (const entry of fs.readdirSync(base, { recursive: true, withFileTypes: true })) {
        if (entry.isFile() && SUPPORTED.test(entry.name))
          files.push(path.join(entry.parentPath, entry.name))
      }
    }
  }
  return files
}

/** Comments removed, so a note about how the repo is built is not read as user copy. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(?:^|\s)\/\/[^\n]*/g, '')
}

function packageScripts(): string[] {
  const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
  return Object.keys(parsed.scripts ?? {})
}

describe('commands printed in the UI', () => {
  it('names a script that exists in package.json', () => {
    const scripts = packageScripts()
    const offenders: string[] = []
    for (const file of uiSources()) {
      // Comments are stripped here too: `src/i18n/index.ts` explains in prose that
      // `pnpm install` generates the catalogs, which is not a command shown to a user.
      const text = stripComments(fs.readFileSync(file, 'utf8'))
      for (const match of text.matchAll(PNPM_SCRIPT)) {
        if (!scripts.includes(match[1]!))
          offenders.push(`${path.relative(repoRoot, file)}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('prefers the CLI over a package script in copy a user reads', () => {
    // The panel ships as a bin (`home-hosted`/`hh`); `pnpm run …` only works inside this repo.
    const offenders: string[] = []
    for (const file of uiSources()) {
      if (!COPY_SOURCES.test(file))
        continue
      for (const match of stripComments(fs.readFileSync(file, 'utf8')).matchAll(ANY_PNPM))
        offenders.push(`${path.relative(repoRoot, file)}: ${match[0]}`)
    }
    expect(offenders).toEqual([])
  })
})
