import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

/**
 * No script may invoke a CLI command this release does not have.
 *
 * `scripts/dev.mjs` seeded the dev login by spawning `home-hosted set-password`. The accounts refactor
 * **deleted** that command, and nothing noticed: the spawn answered "unknown command", the seed
 * function returned false, and the script printed the failure to stderr while carrying on — so a
 * wiped `.dev-state/` came up on a **random** first-run secret while the banner still promised `dev`.
 * Everything that already had state kept working, which is why it survived: the broken path is the one
 * a person hits exactly once, on a fresh checkout.
 *
 * The same sweep in `test/services/init.test.ts` covers the *scaffold* it generates; it did not reach
 * `scripts/`. A source scan is what makes the next deletion safe here, because the failure is a
 * spawn whose non-zero status is only printed.
 */
const root = process.cwd()
const SCRIPTS = path.join(root, 'scripts')

/** Commands this release really has, read from the CLI's own dispatch table rather than restated. */
function knownCommands(): Set<string> {
  const source = fs.readFileSync(path.join(root, 'src', 'cli.ts'), 'utf8')
  // `SYNOPSIS` is the reference table: one entry per top-level command, which is what a script names.
  const block = /const SYNOPSIS: Record<string, string> = \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
  const names = [...block.matchAll(/^\s{2}'?([a-z][a-z-]*)'?:/gm)].map(match => match[1]!)
  expect(names.length, 'the SYNOPSIS table must be readable, or this scan proves nothing').toBeGreaterThan(10)

  /**
   * Plus the **pseudo-commands** the dispatcher answers before the table is consulted.
   *
   * `home-hosted help <cmd>` and `home-hosted version` are real invocations that appear in no
   * `SYNOPSIS` entry — `args.ts` recognises them as tokens — so a scan built only from the table
   * would report a correct hint as naming a command that does not exist. Read from `args.ts` rather
   * than hardcoded, so the two stay in step.
   */
  const args = fs.readFileSync(path.join(root, 'src', 'cli', 'args.ts'), 'utf8')
  for (const match of args.matchAll(/const (?:HELP|VERSION)_TOKENS = new Set\(\[([^\]]+)\]\)/g)) {
    for (const token of [...(match[1] ?? '').matchAll(/'([a-z][a-z-]*)'/g)])
      names.push(token[1]!)
  }

  return new Set(names)
}

describe('scripts/ only names CLI commands that exist', () => {
  it('does not spawn a removed command', () => {
    const known = knownCommands()
    // Every `src/cli.ts`, `<command>` pair a script passes to a spawn. The command is the first
    // bare word after the entry path; `--home <dir>` and friends are flags, so they are skipped by
    // the `--` test rather than by position.
    const offenders: string[] = []
    for (const file of fs.readdirSync(SCRIPTS).filter(name => /\.(?:mjs|js|ts)$/.test(name))) {
      const source = fs.readFileSync(path.join(SCRIPTS, file), 'utf8')
      for (const line of source.split('\n')) {
        if (!/src\/cli\.ts/.test(line) || line.trimStart().startsWith('*') || line.trimStart().startsWith('//'))
          continue
        // The argv array on this line, e.g. `['exec','tsx','src/cli.ts','set-password']`.
        const words = [...line.matchAll(/'([^']+)'/g)].map(match => match[1]!)
        const at = words.indexOf('src/cli.ts')
        if (at === -1)
          continue
        const command = words.slice(at + 1).find(word => !word.startsWith('-'))
        if (command === undefined)
          continue
        if (!known.has(command))
          offenders.push(`${file}: \`${command}\` is passed to src/cli.ts but is not a command this release has`)
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * The scan must see the shape it claims to, or it would pass on a broken script too.
   *
   * The line below is the one that was actually there; the mutation check is what makes the guard
   * load-bearing rather than merely present.
   */
  it('catches the removed command it was written for', () => {
    const known = knownCommands()
    const line = '  const result = spawnSync(pnpm, [\'exec\', \'tsx\', \'src/cli.ts\', \'set-password\'], {'
    const words = [...line.matchAll(/'([^']+)'/g)].map(match => match[1]!)
    const at = words.indexOf('src/cli.ts')
    const command = words.slice(at + 1).find(word => !word.startsWith('-'))!
    expect(command).toBe('set-password')
    expect(known.has(command), 'set-password is gone, so this script would fail silently').toBe(false)
  })
})

/**
 * A message that tells a person to run a command must name one this release has.
 *
 * `src/middleware/auth.ts` answered `AUTH_DISABLED_REMOTE` with *"set a password
 * (`home-hosted set-password`) to reach it"* — a command the accounts refactor deleted. Nothing
 * caught it because the refusal is a string, not a spawn: the `scripts/` scan above only reads lines
 * that pass a command to `src/cli.ts`, and the docs links resolve whatever a message says.
 *
 * This is the user-facing half of the same deletion. A person reading it runs a command that is not
 * there, and the message that was supposed to unblock them is the thing that blocks them.
 */
describe('no user-facing message names a command this release does not have', () => {
  /**
   * A **backticked** `home-hosted <command>` hint.
   *
   * The backticks are load-bearing: without them the pattern matched prose — "is another home-hosted
   * running?", "no home-hosted state to migrate" — and reported fourteen offenders of which two were
   * real. A guard that cries wolf gets switched off, so this only reads what is formatted as a command.
   */
  const HINT = /`home-hosted\s+([a-z][a-z-]*)/g

  it('only names live commands in src/', () => {
    const known = knownCommands()
    const offenders: string[] = []
    for (const entry of fs.readdirSync(path.join(root, 'src'), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts'))
        continue
      const file = path.join(entry.parentPath, entry.name)
      const relative = path.relative(root, file)
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      for (const [index, line] of lines.entries()) {
        for (const match of line.matchAll(HINT)) {
          const command = match[1]
          if (command === undefined || known.has(command))
            continue
          // `--version` and friends are flags the regex cannot see; a single-letter capture is not a
          // command name either.
          if (command.length < 3)
            continue
          offenders.push(`${relative}:${index + 1} names \`home-hosted ${command}\`, which is not a command`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('only names live commands in the shipped docs', () => {
    // The same class, one layer further out: a doc is what a person reads before typing anything.
    const known = knownCommands()
    const offenders: string[] = []
    for (const file of ['README.md', ...fs.readdirSync(path.join(root, 'docs')).filter(name => name.endsWith('.md')).map(name => path.join('docs', name))]) {
      const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n')
      for (const [index, line] of lines.entries()) {
        for (const match of line.matchAll(HINT)) {
          const command = match[1]
          if (command !== undefined && command.length >= 3 && !known.has(command))
            offenders.push(`${file}:${index + 1} names \`home-hosted ${command}\`, which is not a command`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('catches the message it was written for', () => {
    // The string that shipped. Kept as a literal so the regex is proven against real prose, not a shape
    // invented to fit it.
    const shipped = 'authentication is off — set a password (`home-hosted set-password`) to reach it'
    const known = knownCommands()
    const named = [...shipped.matchAll(HINT)].map(match => match[1])
    expect(named).toEqual(['set-password'])
    expect(known.has('set-password'), 'set-password is gone, so this hint sends a reader nowhere').toBe(false)
  })
})

/**
 * A doc that names the **dev ports** must name the ones `scripts/dev.mjs` really binds.
 *
 * `README.md` said "panel :6000 + stock UI dev server :6001" while `dev.mjs` had used **6600/6601** for
 * long enough that `docs/UI_CREATION.md` was written against the new numbers. Nothing compared a number
 * in a document to the number in the source, so the one command in the README's working section sent a
 * person to a port nothing was listening on — the first thing they would try, on a fresh checkout.
 *
 * The numbers are read from `dev.mjs` rather than restated, for the same reason the command list is
 * read from `SYNOPSIS`: a guard that hardcodes the answer agrees with itself.
 */
describe('the docs name the dev ports the script really binds', () => {
  /** The two ports `scripts/dev.mjs` defaults to, from its own constants. */
  function devPorts(): { panel: string, ui: string } {
    const source = fs.readFileSync(path.join(root, 'scripts', 'dev.mjs'), 'utf8')
    const panel = /const DEFAULT_PANEL_PORT = (\d+)/.exec(source)?.[1]
    const ui = /const DEFAULT_UI_PORT = (\d+)/.exec(source)?.[1]
    expect(panel, 'DEFAULT_PANEL_PORT must be readable, or this scan proves nothing').toBeDefined()
    expect(ui, 'DEFAULT_UI_PORT must be readable, or this scan proves nothing').toBeDefined()
    return { panel: panel!, ui: ui! }
  }

  it('names the panel and UI dev ports correctly wherever a doc mentions them', () => {
    const { panel, ui } = devPorts()
    const offenders: string[] = []
    const docs = [
      'README.md',
      ...fs.readdirSync(path.join(root, 'docs')).filter(name => name.endsWith('.md')).map(name => `docs/${name}`),
    ]
    for (const file of docs) {
      for (const [index, line] of fs.readFileSync(path.join(root, file), 'utf8').split('\n').entries()) {
        /**
         * Only a line that is **about the dev server** is checked — it has to mention `dev` and a port.
         * A bare `:6600` elsewhere (a measured example in prose) is a fact about the past, not an
         * instruction, and rewriting those would lose the evidence they carry.
         */
        if (!/\b(?:pnpm dev|dev server|dev-server)\b/.test(line))
          continue
        for (const match of line.matchAll(/:(\d{4})\b/g)) {
          const port = match[1]
          if (port !== panel && port !== ui)
            offenders.push(`${file}:${index + 1} names :${port}, but dev.mjs binds :${panel}/:${ui}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('catches the line it was written for', () => {
    const { panel, ui } = devPorts()
    // The line that shipped, with the wrong ports.
    const shipped = 'pnpm dev            # panel :6000 + stock UI dev server :6001, state in .dev-state/'
    const named = [...shipped.matchAll(/:(\d{4})\b/g)].map(match => match[1]!)
    expect(named).toEqual(['6000', '6001'])
    expect(named.some(port => port === panel || port === ui), 'neither wrong port is a real dev port').toBe(false)
  })
})

/**
 * A sample entry in the docs must use fields the schema really has.
 *
 * The README's opening example — `{ "id": "gateway", "command": "node", … }` — is the first thing a person
 * copies. Every key in it is also a fact that lives in `serverSchema`, and nothing compared the two: a
 * renamed field would leave the sample describing a file the panel refuses, with `onUndeclaredKey('reject')`
 * turning it into an error the reader cannot explain.
 *
 * This is the third member of one class, after the command names and the dev ports: **a fact a doc states
 * that also exists in code will drift unless something compares them**.
 */
describe('a documented sample entry uses fields the schema has', () => {
  /** Field names `serverSchema` declares, read from the shared module. */
  function entryFields(): Set<string> {
    const source = fs.readFileSync(path.join(root, 'src', 'shared', 'contracts.ts'), 'utf8')
    const start = source.indexOf('export const serverSchema = lazy(')
    expect(start, 'serverSchema must be readable, or this scan proves nothing').toBeGreaterThan(-1)
    // Up to the closing of this `lazy(...)` — the next top-level `export` after it.
    const next = source.indexOf('\nexport ', start + 10)
    const body = source.slice(start, next === -1 ? undefined : next)
    const fields = [...body.matchAll(/^\s{2}'?([a-z][A-Za-z]*)'?\??:/gm)].map(match => match[1]!)
    expect(fields.length, 'the field scan must find the entry schema, not an empty block').toBeGreaterThan(10)
    return new Set(fields)
  }

  it('uses only real entry fields in the README example', () => {
    const known = entryFields()
    /**
     * Normalise line endings **before** matching, and match the fence on `\r?\n`.
     *
     * A `core.autocrlf` checkout gives CRLF, and `/```json\n/` then finds nothing: this test passed on
     * Linux and failed on Windows with *"no entry sample found — the README example moved"*, blaming the
     * README for the checkout's line endings. `scripts/release-notes.mjs` carries the same trap in its own
     * comments; it splits on `/\r\n|\r|\n/` for exactly this reason.
     */
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').split(/\r\n|\r|\n/).join('\n')
    /**
     * The fenced `json` block that carries an `"id"` and a `"command"` — the entry sample, found by its
     * shape rather than by a line number, so an edit above it does not break the scan.
     */
    const blocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map(match => match[1] ?? '')
    const samples = blocks.filter(block => /"id"\s*:/.test(block) && /"command"\s*:/.test(block))
    expect(samples.length, 'no entry sample found — the README example moved or changed shape').toBeGreaterThan(0)

    const offenders: string[] = []
    for (const sample of samples) {
      for (const match of sample.matchAll(/"([a-z]+)"\s*:/gi)) {
        const key = match[1]!
        if (!known.has(key))
          offenders.push(`README.md sample uses "${key}", which serverSchema does not declare`)
      }
    }
    expect(offenders).toEqual([])
  })
})
