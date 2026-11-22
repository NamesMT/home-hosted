import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stripComments } from '../helpers/strip-comments'
import { uiNames } from '../support/uis'

/**
 * A command printed in the UI is a promise the package has to keep.
 *
 * The login page's rescue line — the one sentence a locked-out user is given — told them to run
 * `pnpm run auth:set-password`, which has never existed in `package.json` (the script is
 * `set-password`). Nothing failed: it was a string in a template, so it rendered forever and only
 * a person following it found out. A UI must name the CLI, which is versioned with the panel,
 * rather than a package script that only someone inside this repo can run.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))
const repoRoot = root

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
  for (const ui of uiNames()) {
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
      const text = stripComments(fs.readFileSync(file, 'utf8'), file)
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
      for (const match of stripComments(fs.readFileSync(file, 'utf8'), file).matchAll(ANY_PNPM))
        offenders.push(`${path.relative(repoRoot, file)}: ${match[0]}`)
    }
    expect(offenders).toEqual([])
  })

  /**
   * A command hint in **server** copy goes through `invocation()`.
   *
   * `invocation()` carries `--home` when the caller chose a state directory, quoted for the shell, and
   * resolves the program for an installed bin, `npx home-hosted` and a source checkout alike. A literal
   * `home-hosted account reset` in an error message tells someone with a `--home` panel to run a command
   * against the *default* home — which created `~/.home-hosted` beside the state they meant.
   *
   * Eight messages had drifted: the sign-in lockout, three `SESSION_REQUIRED` refusals, the backup
   * restore and UI install refusals, and two `contracts.ts` config refusals. The last two are in
   * `src/shared`, which may not import `cli/io`, so they keep the literal — the allow-list below is
   * exactly those two, named rather than inferred.
   */
  it('uses invocation() for a command hint in server copy', () => {
    const offenders: string[] = []
    let scanned = 0
    for (const entry of fs.readdirSync(path.join(repoRoot, 'src'), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts'))
        continue
      const file = path.join(entry.parentPath, entry.name)
      const relative = path.relative(repoRoot, file).replaceAll('\\', '/')
      /**
       * `src/shared` cannot import `cli/io`, so a hint there keeps the literal — the allow-list below is
       * those files, named rather than inferred.
       *
       * `src/cli/` was excluded whole, and that was wrong: a CLI command prints to a person like any other,
       * and `cli/io` is importable *from* `cli/`. The exclusion hid two real cases — `import.ts`'s
       * "not started — `home-hosted start <id>`" and `import-plan.ts`'s `cron_restart` warning — both of
       * which told someone importing with `--home` to run a command against the *default* home. Only
       * `cli/io.ts` itself is exempt now: it *is* `invocation()`, so its own text cannot call it.
       */
      if (relative === 'src/cli/io.ts' || relative === 'src/cli/import-plan.ts')
        continue
      // A comment inside a script the panel *generates* for the host: it runs on Windows, where the panel's
      // own `invocation()` (a Node bin path) would be the wrong thing to print. Not a hint to a person.
      if (relative === 'src/providers/wsl-temperature.ts')
        continue
      scanned += 1
      const source = stripComments(fs.readFileSync(file, 'utf8'), file)
      /**
       * The shape that matters: a backtick string naming a `home-hosted` subcommand, in a file that could
       * have called `invocation()`. Matching the literal alone is enough — the escapes and conditions I
       * first wrote skipped the very case this test exists for.
       */
      for (const match of source.matchAll(/`[^`\n]*home-hosted [a-z][^`\n]*`/g)) {
        if (match[0].includes('${invocation()'))
          continue
        /**
         * A **status** sentence, not a hint: "home-hosted is not running", "no home-hosted state to
         * migrate". Nobody types those, so they need no `--home` — and requiring one would push the
         * authors to reword a clear message. Only a phrase that reads as something to *run* counts.
         */
        if (/home-hosted (?:is|was) not running|home-hosted is already running|no home-hosted state/.test(match[0]))
          continue
        /**
         * A marker **written into a file** a manager reads, not printed to a person: `SERVICE_MARKER` goes
         * into a systemd unit, a launchd plist and a Task Scheduler XML. A `--home` there would describe the
         * machine that wrote it, not the one running the service later — and the marker's job is to prove
         * ownership when a person inspects the unit by hand.
         */
        /**
         * `service.ts` emits **service definitions**, not hints: a `Description=` line in a systemd unit and
         * a plist `Description` naming the product, plus the ownership marker. None of them is something a
         * person types, and a `--home` in a unit file would name the machine that wrote it rather than the
         * one that runs the service.
         */
        if (relative === 'src/cli/service.ts')
          continue
        offenders.push(`${relative}: ${match[0].slice(0, 90)}`)
      }
    }
    expect(scanned, 'the scan found no server sources — a broken glob would pass for free').toBeGreaterThan(30)
    expect(offenders, 'a command hint must carry --home; use invocation()').toEqual([])
  })
})
